const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { createAgentRuntime } = require('./lib/agent-runtime');
const {
  DEFAULT_AGENT,
  getAgentConfig,
  getAgentIds,
  getPublicAgentCatalog,
  getRuntimeSessionField,
  normalizeAgent,
} = require('./lib/agent-registry');
const { createCodexRolloutStore } = require('./lib/codex-rollouts');
const { readGitFileDiff, readGitHistory } = require('./lib/git-workspace');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = parseInt(process.env.PORT) || 8002;
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
function getLanIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function printAccessUrls() {
  console.log('CC-Web server listening:');
  console.log(`  Local: http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    const lanAddresses = getLanIPv4Addresses();
    if (lanAddresses.length > 0) {
      for (const address of lanAddresses) {
        console.log(`  LAN:   http://${address}:${PORT}`);
      }
    } else {
      console.log('  LAN:   No LAN IPv4 address detected');
    }
    return;
  }
  console.log(`  Host:  http://${HOST}:${PORT}`);
}
function isConfiguredCliPathUsable(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  const looksLikePath = /[\\/]/.test(value) || /\.[a-z0-9]+$/i.test(value) || path.isAbsolute(value);
  if (!looksLikePath) return true;
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}
function quoteWindowsCmdArg(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"&()^<>|]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
function resolveDefaultCodexPath() {
  if (isConfiguredCliPathUsable(process.env.CODEX_PATH)) return process.env.CODEX_PATH;
  if (process.platform !== 'win32') return 'codex';
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const cmdPath = path.join(appData, 'npm', 'codex.cmd');
  if (fs.existsSync(cmdPath)) return cmdPath;

  try {
    const userProfile = process.env.USERPROFILE || '';
    const extRoot = path.join(userProfile, '.vscode', 'extensions');
    if (extRoot && fs.existsSync(extRoot)) {
      const candidates = fs.readdirSync(extRoot)
        .filter((name) => /^openai\.chatgpt-/i.test(name))
        .sort()
        .reverse();
      for (const name of candidates) {
        const exePath = path.join(extRoot, name, 'bin', 'windows-x86_64', 'codex.exe');
        if (fs.existsSync(exePath)) return exePath;
      }
    }
  } catch {}

  return 'codex';
}
const CODEX_PATH = resolveDefaultCodexPath();
function resolveDefaultCodebuddyPath() {
  if (isConfiguredCliPathUsable(process.env.CODEBUDDY_PATH)) return process.env.CODEBUDDY_PATH;
  if (process.platform !== 'win32') return 'codebuddy';
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'npm', 'codebuddy.cmd'),
    path.join(appData, 'npm', 'cbc.cmd'),
    path.join(appData, 'npm', 'codebuddy.ps1'),
    path.join(appData, 'npm', 'cbc.ps1'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'codebuddy';
}
const CODEBUDDY_PATH = resolveDefaultCodebuddyPath();
function resolveDefaultKimiPath() {
  if (isConfiguredCliPathUsable(process.env.KIMI_PATH)) return process.env.KIMI_PATH;
  if (process.platform !== 'win32') return 'kimi';
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const cmdPath = path.join(appData, 'npm', 'kimi.cmd');
  if (fs.existsSync(cmdPath)) return cmdPath;
  return 'kimi';
}
const KIMI_PATH = resolveDefaultKimiPath();
function resolveDefaultOpencodePath() {
  if (isConfiguredCliPathUsable(process.env.OPENCODE_PATH)) return process.env.OPENCODE_PATH;
  if (process.platform !== 'win32') return 'opencode';
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const ps1Path = path.join(appData, 'npm', 'opencode.ps1');
  if (fs.existsSync(ps1Path)) return ps1Path;
  return 'opencode';
}
const OPENCODE_PATH = resolveDefaultOpencodePath();

function getCliInstallInfo(command, args = ['--version']) {
  try {
    const normalizedCommand = String(command || '').trim();
    if (!normalizedCommand) {
      return { installed: false, version: '', error: 'empty_command' };
    }
    const isWindows = process.platform === 'win32';
    const isWindowsPsScript = isWindows && /\.ps1$/i.test(normalizedCommand);
    const isWindowsCmdScript = isWindows && /\.(cmd|bat)$/i.test(normalizedCommand);
    const isBareCommand = !/[\\/]/.test(normalizedCommand) && !/\.[a-z0-9]+$/i.test(normalizedCommand);
    const spawnCommand = isWindowsPsScript
      ? 'powershell.exe'
      : isWindowsCmdScript || (isWindows && isBareCommand)
        ? 'cmd.exe'
        : normalizedCommand;
    const spawnArgs = isWindowsPsScript
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', normalizedCommand, ...args]
      : isWindowsCmdScript
        ? ['/d', '/s', '/c', `"${normalizedCommand}" ${args.join(' ')}`]
        : (isWindows && isBareCommand)
          ? ['/d', '/s', '/c', `${normalizedCommand} ${args.join(' ')}`]
          : args;
    const result = spawnSync(spawnCommand, spawnArgs, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      return { installed: false, version: '', error: result.error.message || 'spawn_failed' };
    }
    if (result.status !== 0) {
      const output = String(result.stdout || result.stderr || '').trim();
      return { installed: false, version: '', error: output || `exit_${result.status}` };
    }
    const output = String(result.stdout || result.stderr || '').trim();
    const firstLine = output.split(/\r?\n/).find(Boolean) || '';
    return {
      installed: true,
      version: firstLine || output || '已安装',
      error: '',
    };
  } catch (error) {
    return { installed: false, version: '', error: error?.message || 'unknown_error' };
  }
}

function getCliInstallStatus() {
  const status = {
    claude: getCliInstallInfo(CLAUDE_PATH),
    codex: getCliInstallInfo(CODEX_PATH),
    codebuddy: getCliInstallInfo(CODEBUDDY_PATH),
    kimi: getCliInstallInfo(KIMI_PATH),
    opencode: getCliInstallInfo(OPENCODE_PATH),
  };
  if (!status.codex.installed && process.platform === 'win32' && CODEX_PATH !== 'codex') {
    const fallback = getCliInstallInfo('codex');
    if (fallback.installed) status.codex = fallback;
  }
  if (!status.codebuddy.installed) {
    for (const candidate of ['codebuddy', 'cbc']) {
      const fallback = getCliInstallInfo(candidate);
      if (fallback.installed) {
        status.codebuddy = fallback;
        break;
      }
    }
  }
  return status;
}

const CONFIG_DIR = process.env.CC_WEB_CONFIG_DIR || path.join(__dirname, 'config');
const SESSIONS_DIR = process.env.CC_WEB_SESSIONS_DIR || path.join(__dirname, 'sessions');
const PUBLIC_DIR = process.env.CC_WEB_PUBLIC_DIR || path.join(__dirname, 'public');
const LOGS_DIR = process.env.CC_WEB_LOGS_DIR || path.join(__dirname, 'logs');
const ATTACHMENTS_DIR = path.join(SESSIONS_DIR, '_attachments');
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 4;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const NOTIFY_CONFIG_PATH = path.join(CONFIG_DIR, 'notify.json');
const AUTH_CONFIG_PATH = path.join(CONFIG_DIR, 'auth.json');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const CODEX_CONFIG_PATH = path.join(CONFIG_DIR, 'codex.json');
const CODEBUDDY_CONFIG_PATH = path.join(CONFIG_DIR, 'codebuddy.json');
const KIMI_CONFIG_PATH = path.join(CONFIG_DIR, 'kimi.json');
const AGENT_MODEL_PREFERENCES_PATH = path.join(CONFIG_DIR, 'agent-models.json');
const BANNED_IPS_PATH = path.join(CONFIG_DIR, 'banned_ips.json');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// === Process Lifecycle Logger ===
const LOG_FILE = path.join(LOGS_DIR, 'process.log');
const LOG_MAX_SIZE = 2 * 1024 * 1024; // 2MB per file

function plog(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Simple rotation: if file > 2MB, rename to .old and start fresh
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > LOG_MAX_SIZE) {
        const oldFile = LOG_FILE.replace('.log', '.old.log');
        try { fs.unlinkSync(oldFile); } catch {}
        fs.renameSync(LOG_FILE, oldFile);
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// === Notification System ===
const DEFAULT_SUMMARY_CONFIG = {
  enabled: false,
  trigger: 'background', // 'background' | 'always'
  apiSource: 'claude',   // 'claude' | 'codex' | 'custom'
  apiBase: '',
  apiKey: '',
  model: '',
};

function loadNotifyConfig() {
  try {
    if (fs.existsSync(NOTIFY_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(NOTIFY_CONFIG_PATH, 'utf8'));
      // Ensure summary field exists for older configs
      if (!raw.summary) raw.summary = { ...DEFAULT_SUMMARY_CONFIG };
      return raw;
    }
  } catch {}
  // First run: migrate from .env PUSHPLUS_TOKEN
  const token = process.env.PUSHPLUS_TOKEN || '';
  const config = {
    provider: token ? 'pushplus' : 'off',
    pushplus: { token },
    telegram: { botToken: '', chatId: '' },
    serverchan: { sendKey: '' },
    feishu: { webhook: '' },
    qqbot: { qmsgKey: '' },
    summary: { ...DEFAULT_SUMMARY_CONFIG },
  };
  saveNotifyConfig(config);
  return config;
}

function saveNotifyConfig(config) {
  fs.writeFileSync(NOTIFY_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function maskToken(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getNotifyConfigMasked() {
  const config = loadNotifyConfig();
  const s = config.summary || {};
  return {
    provider: config.provider,
    pushplus: { token: maskToken(config.pushplus?.token) },
    telegram: { botToken: maskToken(config.telegram?.botToken), chatId: config.telegram?.chatId || '' },
    serverchan: { sendKey: maskToken(config.serverchan?.sendKey) },
    feishu: { webhook: maskToken(config.feishu?.webhook) },
    qqbot: { qmsgKey: maskToken(config.qqbot?.qmsgKey) },
    summary: {
      enabled: !!s.enabled,
      trigger: s.trigger || 'background',
      apiSource: s.apiSource || 'claude',
      apiBase: s.apiBase || '',
      apiKey: maskToken(s.apiKey),
      model: s.model || '',
    },
  };
}

// === Notification Summary ===

// Per-channel content length limits (chars)
const NOTIFY_CONTENT_LIMITS = {
  telegram: 3800,
  qqbot: 3800,
  serverchan: 30000,
  pushplus: 18000,
  feishu: 18000,
};

function truncateForChannel(text, provider) {
  const limit = NOTIFY_CONTENT_LIMITS[provider] || 18000;
  if (text.length <= limit) return text;
  return text.slice(0, limit - 20) + '\n\n[内容已截断]';
}

function getSummaryApiCredentials(summaryConfig) {
  // Returns { apiBase, apiKey, model } or null
  const src = summaryConfig.apiSource || 'claude';
  if (src === 'claude') {
    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find(t => t.name === modelCfg.activeTemplate);
      if (tpl && tpl.apiKey && tpl.apiBase) {
        return { apiBase: tpl.apiBase, apiKey: tpl.apiKey, model: tpl.defaultModel || tpl.opusModel || '' };
      }
    }
    return null; // local mode — no API credentials available
  }
  if (src === 'codex') {
    const codexCfg = loadCodexConfig();
    if (codexCfg.mode === 'custom' && codexCfg.activeProfile) {
      const profile = (codexCfg.profiles || []).find(p => p.name === codexCfg.activeProfile);
      if (profile && profile.apiKey && profile.apiBase) {
        return { apiBase: profile.apiBase, apiKey: profile.apiKey, model: summaryConfig.model || '' };
      }
    }
    return null;
  }
  if (src === 'custom') {
    if (summaryConfig.apiBase && summaryConfig.apiKey) {
      return { apiBase: summaryConfig.apiBase, apiKey: summaryConfig.apiKey, model: summaryConfig.model || '' };
    }
    return null;
  }
  return null;
}

function callSummaryApi(creds, prompt) {
  return new Promise((resolve) => {
    try {
      const base = creds.apiBase.replace(/\/+$/, '');
      const url = new URL(base + '/v1/chat/completions');
      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const model = creds.model || 'claude-opus-4-6';
      const body = JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.message?.content || json.content?.[0]?.text || '';
            resolve({ ok: !!text, text: text.trim() });
          } catch {
            resolve({ ok: false, text: '' });
          }
        });
      });
      req.on('error', () => resolve({ ok: false, text: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, text: '' }); });
      req.write(body);
      req.end();
    } catch {
      resolve({ ok: false, text: '' });
    }
  });
}

function buildSummaryPrompt(sessionTitle, lastUserMsg, fullText, isError, errorDesc) {
  const userSnip = (lastUserMsg || '').slice(0, 300);
  const outputSnip = (fullText || '').slice(0, 15000);
  const base = `会话：${sessionTitle}\n用户请求：${userSnip}\n\n以下是助手的输出内容：\n${outputSnip}`;
  if (isError) {
    return base + `\n\n错误信息：${(errorDesc || '').slice(0, 300)}\n\n` +
      `请用纯文本简要说明本次任务做了什么、遇到了什么问题。` +
      `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
  }
  return base + `\n\n请用纯文本简要说明本次任务做了什么、结论是否成功。` +
    `要求：1. 不超过 200 字  2. 可以有序号和适当分段  3. 不要罗列具体代码、函数名、文件路径等细节  4. 不使用 markdown 格式（无星号、井号、横线等符号）`;
}

async function buildNotifyContent(entry, session, completionError, contextLimitExceeded) {
  const title = session?.title || 'Untitled';
  const agent = normalizeAgent(entry.agent);
  const agentLabel = getAgentLabel(agent);
  const hasTools = (entry.toolCalls || []).length > 0;

  // Determine notify title
  let notifyTitle;
  if (contextLimitExceeded) {
    notifyTitle = `⚠ ${title} 上下文已压缩`;
  } else if (completionError) {
    notifyTitle = `✗ ${title} 任务异常`;
  } else if (hasTools) {
    notifyTitle = `✓ ${title} 任务完成`;
  } else {
    notifyTitle = `✓ ${title} 回复就绪`;
  }

  // Context limit: fixed message, no AI
  if (contextLimitExceeded) {
    return { title: notifyTitle, content: `${agentLabel} 会话上下文已达上限，已自动触发压缩。\n会话: ${title}` };
  }

  // Check if summary is enabled and applicable
  const notifyCfg = loadNotifyConfig();
  const summaryCfg = notifyCfg.summary || {};
  const summaryEnabled = !!summaryCfg.enabled;

  if (!summaryEnabled) {
    // Fallback: simple content
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  const creds = getSummaryApiCredentials(summaryCfg);
  if (!creds) {
    // No credentials — fallback
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    return { title: notifyTitle, content: lines.join('\n') };
  }

  // Get last user message from session
  const messages = session?.messages || [];
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const lastUserMsg = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const prompt = buildSummaryPrompt(title, lastUserMsg, entry.fullText || '', !!completionError, completionError || '');
  const result = await callSummaryApi(creds, prompt);

  let bodyText;
  if (result.ok && result.text) {
    bodyText = result.text;
  } else {
    // Fallback on API failure
    const lines = [`会话: ${title}`];
    if (completionError) lines.push(`错误: ${completionError.slice(0, 200)}`);
    if (!result.ok) lines.push('（摘要生成失败，以上为原始信息）');
    bodyText = lines.join('\n');
  }

  return { title: notifyTitle, content: bodyText };
}

function sendNotification(title, content) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') return Promise.resolve({ ok: true, skipped: true });
  const https = require('https');
  const truncated = truncateForChannel(content, config.provider);

  return new Promise((resolve) => {
    let url, data;
    let isFormData = false;
    switch (config.provider) {
      case 'pushplus': {
        if (!config.pushplus?.token) return resolve({ ok: false, error: 'PushPlus token 未配置' });
        url = 'https://www.pushplus.plus/send';
        data = JSON.stringify({ token: config.pushplus.token, title, content: truncated, template: 'txt' });
        break;
      }
      case 'telegram': {
        if (!config.telegram?.botToken || !config.telegram?.chatId) return resolve({ ok: false, error: 'Telegram botToken 或 chatId 未配置' });
        url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
        data = JSON.stringify({ chat_id: config.telegram.chatId, text: `${title}\n\n${truncated}` });
        break;
      }
      case 'serverchan': {
        if (!config.serverchan?.sendKey) return resolve({ ok: false, error: 'Server酱 sendKey 未配置' });
        url = `https://sctapi.ftqq.com/${config.serverchan.sendKey}.send`;
        data = JSON.stringify({ title, desp: truncated });
        break;
      }
      case 'feishu': {
        if (!config.feishu?.webhook) return resolve({ ok: false, error: '飞书 Webhook 未配置' });
        url = config.feishu.webhook;
        data = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n\n${truncated}` } });
        break;
      }
      case 'qqbot': {
        if (!config.qqbot?.qmsgKey) return resolve({ ok: false, error: 'Qmsg Key 未配置' });
        url = `https://qmsg.zendee.cn/send/${config.qqbot.qmsgKey}`;
        data = `msg=${encodeURIComponent(`${title}\n\n${truncated}`)}`;
        isFormData = true;
        break;
      }
      default:
        return resolve({ ok: false, error: `未知通知方式: ${config.provider}` });
    }

    const parsed = new URL(url);
    const contentType = isFormData ? 'application/x-www-form-urlencoded' : 'application/json';
    const reqOptions = {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(parsed, reqOptions, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        plog('INFO', 'notify_response', { provider: config.provider, status: res.statusCode, body: body.slice(0, 200) });
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => {
      plog('WARN', 'notify_error', { provider: config.provider, error: e.message });
      resolve({ ok: false, error: e.message });
    });
    req.write(data);
    req.end();
  });
}

// Load config on startup (ensures migration)
loadNotifyConfig();

// === Auth Config ===
function generateRandomPassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

function buildHashedAuthConfig(password, mustChange = false) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(password || ''), passwordSalt, 64).toString('hex');
  return {
    passwordAlgorithm: 'scrypt',
    passwordSalt,
    passwordHash,
    mustChange: !!mustChange,
  };
}

function verifyPassword(password, config) {
  const candidate = String(password || '');
  const auth = config && typeof config === 'object' ? config : null;
  if (!auth) return false;

  if (auth.passwordHash && auth.passwordSalt) {
    try {
      const actual = crypto.scryptSync(candidate, String(auth.passwordSalt), 64);
      const expected = Buffer.from(String(auth.passwordHash), 'hex');
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  return typeof auth.password === 'string' && candidate === auth.password;
}

function loadAuthConfig() {
  // Priority 1: config/auth.json exists with password
  try {
    if (fs.existsSync(AUTH_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(AUTH_CONFIG_PATH, 'utf8'));
      if (config.passwordHash && config.passwordSalt) {
        return {
          passwordAlgorithm: String(config.passwordAlgorithm || 'scrypt'),
          passwordSalt: String(config.passwordSalt),
          passwordHash: String(config.passwordHash),
          mustChange: !!config.mustChange,
        };
      }
      if (config.password) {
        const migrated = buildHashedAuthConfig(config.password, !!config.mustChange);
        saveAuthConfig(migrated);
        return migrated;
      }
    }
  } catch {}

  // Priority 2: .env has CC_WEB_PASSWORD → migrate
  const envPw = process.env.CC_WEB_PASSWORD;
  if (envPw && envPw !== 'changeme') {
    const config = buildHashedAuthConfig(envPw, false);
    saveAuthConfig(config);
    return config;
  }

  // Priority 3: Generate random password
  const pw = generateRandomPassword(12);
  const config = buildHashedAuthConfig(pw, true);
  saveAuthConfig(config);
  console.log('========================================');
  console.log('  自动生成初始密码: ' + pw);
  console.log('  首次登录后将要求修改密码');
  console.log('========================================');
  return config;
}

function saveAuthConfig(config) {
  fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) {
    return { valid: false, message: '密码长度至少 8 位' };
  }
  let types = 0;
  if (/[a-z]/.test(pw)) types++;
  if (/[A-Z]/.test(pw)) types++;
  if (/[0-9]/.test(pw)) types++;
  if (/[^a-zA-Z0-9]/.test(pw)) types++;
  if (types < 2) {
    return { valid: false, message: '密码需包含至少 2 种字符类型（大写/小写/数字/特殊字符）' };
  }
  return { valid: true, message: '' };
}

let authConfig = loadAuthConfig();

const activeTokens = new Set();

// === Anti-brute-force ===
const AUTH_FAIL_WINDOW = 5 * 60 * 1000; // 5 minutes
const AUTH_FAIL_MAX = 3;
const BAN_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const authFailures = new Map(); // ip -> [timestamp, ...]
let bannedIPs = new Map(); // ip -> expireTimestamp

// Tailscale / loopback whitelist — never ban these IPs.
// Extra whitelist can be provided via env var (comma/space separated):
//   CC_WEB_IP_WHITELIST="<ip1>,<ip2>"
const TRUST_PROXY_HEADERS = /^(1|true|yes)$/i.test(String(process.env.CC_WEB_TRUST_PROXY || ''));
const EXTRA_WHITELIST_IPS = new Set(
  String(process.env.CC_WEB_IP_WHITELIST || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^::ffff:/, ''))
);

function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

function isLoopbackIp(ip) {
  const cleaned = normalizeIp(ip);
  return cleaned === '127.0.0.1' || cleaned === '::1';
}

function isWhitelistedIP(ip) {
  const cleaned = normalizeIp(ip);
  if (!cleaned) return false;
  return cleaned === '127.0.0.1'
    || cleaned === '::1'
    || cleaned.startsWith('100.')
    || EXTRA_WHITELIST_IPS.has(cleaned);
}

function loadBannedIPs() {
  try {
    if (fs.existsSync(BANNED_IPS_PATH)) {
      const data = JSON.parse(fs.readFileSync(BANNED_IPS_PATH, 'utf8'));
      if (Array.isArray(data)) {
        const exp = Date.now() + BAN_DURATION;
        bannedIPs = new Map(data.map(ip => [ip, exp]));
      } else {
        bannedIPs = new Map(Object.entries(data).map(([ip, t]) => [ip, Number(t)]));
      }
    }
  } catch { bannedIPs = new Map(); }
}
function saveBannedIPs() {
  const obj = Object.fromEntries(bannedIPs);
  fs.writeFileSync(BANNED_IPS_PATH, JSON.stringify(obj, null, 2));
}
loadBannedIPs();

function getClientIP(ws) {
  const req = ws._req;
  if (!req) return null;
  const socketIp = normalizeIp(req.socket?.remoteAddress || '');
  if (TRUST_PROXY_HEADERS || isLoopbackIp(socketIp)) {
    const realIp = normalizeIp(req.headers['x-real-ip']);
    if (realIp) return realIp;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
    const forwardedIp = normalizeIp(forwarded);
    if (forwardedIp) return forwardedIp;
  }
  return socketIp || null;
}

function isBanned(ip) {
  if (!ip || !bannedIPs.has(ip)) return false;
  const exp = bannedIPs.get(ip);
  if (exp !== -1 && Date.now() > exp) {
    bannedIPs.delete(ip);
    saveBannedIPs();
    return false;
  }
  return true;
}

function recordAuthFailure(ip) {
  if (!ip || isWhitelistedIP(ip)) return false;
  const now = Date.now();
  let list = authFailures.get(ip) || [];
  list.push(now);
  list = list.filter(t => now - t < AUTH_FAIL_WINDOW);
  authFailures.set(ip, list);
  if (list.length >= AUTH_FAIL_MAX) {
    bannedIPs.set(ip, Date.now() + BAN_DURATION);
    saveBannedIPs();
    authFailures.delete(ip);
    plog('WARN', 'ip_banned', { ip, reason: `${AUTH_FAIL_MAX} failed auth in ${AUTH_FAIL_WINDOW / 1000}s` });
    return true;
  }
  return false;
}

// Pending slash command metadata: sessionId -> { kind: string }
const pendingSlashCommands = new Map();

// Pending compact retry metadata: sessionId -> { text: string, mode: string, reason: string }
const pendingCompactRetries = new Map();

// Active processes: sessionId -> { pid, ws, fullText, toolCalls, assistantSteps, lastCost, tailer }
const activeProcesses = new Map();

// Track which session each ws is viewing: ws -> sessionId
const wsSessionMap = new Map();

// Default fallback MODEL_MAP (overridden by model config at runtime)
// opus/sonnet use [1m] suffix to enable 1M context window by default
let MODEL_MAP = {
  opus: 'claude-opus-4-6[1m]',
  sonnet: 'claude-sonnet-4-6[1m]',
  haiku: 'claude-haiku-4-5-20251001',
};

function getAgentLabel(agent) {
  return getAgentConfig(agent).label || getAgentConfig(DEFAULT_AGENT).label || 'Agent';
}

function isUsageMeteredAgent(agent) {
  const normalized = normalizeAgent(agent);
  return normalized === 'codex' || normalized === 'codebuddy' || normalized === 'opencode';
}

function usesAgentsMarkdown(agent) {
  const normalized = normalizeAgent(agent);
  return normalized === 'codex' || normalized === 'codebuddy' || normalized === 'kimi' || normalized === 'opencode';
}

function resolveAgentDefaultSessionModel(agent) {
  const rememberedModel = getRememberedAgentModel(agent);
  if (rememberedModel) return rememberedModel;
  const spec = getAgentConfig(agent).defaults?.defaultSessionModel || null;
  if (normalizeAgent(agent) === 'opencode') {
    return resolveOpencodeDefaultModel();
  }
  if (!spec) return null;
  if (spec.source === 'model-map') {
    return MODEL_MAP[spec.key] || null;
  }
  if (spec.source === 'kimi-config-default') {
    return getKimiEffectiveModelCatalog().defaultModel || getLatestKnownSessionModel('kimi') || null;
  }
  if (spec.source === 'literal') {
    return spec.value || null;
  }
  return null;
}

function resolveAgentDefaultCwd(agent) {
  const spec = getAgentConfig(agent).defaults?.localTaskCwd || null;
  if (spec?.source === 'home') return getHomeDir();
  return null;
}

function resolveOpencodeConfigPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.config', 'opencode', 'opencode.json');
}

function loadOpencodeConfigFile() {
  try {
    const filePath = resolveOpencodeConfigPath();
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getLatestKnownSessionModel(agent) {
  const targetAgent = normalizeAgent(agent);
  let latestModel = null;
  let latestTime = -1;
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR).filter((entry) => entry.endsWith('.json'))) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
        if (getSessionAgent(session) !== targetAgent) continue;
        const model = String(session?.model || '').trim();
        if (!model) continue;
        const updatedAt = new Date(session?.updated || session?.created || 0).getTime();
        if (!Number.isFinite(updatedAt)) continue;
        if (updatedAt > latestTime) {
          latestTime = updatedAt;
          latestModel = model;
        }
      } catch {}
    }
  } catch {}
  return latestModel;
}

function resolveOpencodeConfiguredModel(config) {
  const cfg = config || loadOpencodeConfigFile();
  if (!cfg || typeof cfg !== 'object') return null;

  const direct = String(cfg.model || '').trim();
  if (direct) return direct;

  const buildAgent = String(cfg.agent?.build?.model || '').trim();
  if (buildAgent) return buildAgent;

  const legacyBuild = String(cfg.mode?.build?.model || '').trim();
  if (legacyBuild) return legacyBuild;

  return null;
}

function resolveOpencodeDefaultModel() {
  const configured = resolveOpencodeConfiguredModel();
  if (configured) return configured;

  const recentKnownModel = getLatestKnownSessionModel('opencode');
  if (recentKnownModel) return recentKnownModel;

  try {
    for (const session of getOpencodeSessionList().slice(0, 10)) {
      if (!session?.sessionId) continue;
      const parsed = parseOpencodeExport(loadOpencodeExport(session.sessionId));
      const model = String(parsed?.model || '').trim();
      if (model) return model;
    }
  } catch {
    return null;
  }
  return null;
}

// === Model Config ===
const DEFAULT_MODEL_CONFIG = {
  mode: 'local',      // 'local' | 'custom'
  templates: [],      // array of { name, apiKey, apiBase, defaultModel, opusModel, sonnetModel, haikuModel }
  activeTemplate: '', // name of active template (for 'custom' mode)
  localSnapshot: {},  // saved snapshot of local ~/.claude/settings.json API config
};

const DEFAULT_CODEX_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
  enableSearch: false,
  supportsSearch: false,
  localSnapshot: {},  // saved snapshot of local ~/.codex config (archive-only, no restore)
};

const DEFAULT_CODEBUDDY_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
};

const KIMI_PROVIDER_TYPES = new Set([
  'kimi',
  'openai_legacy',
  'openai_responses',
  'anthropic',
  'gemini',
  'vertexai',
]);

const KIMI_CAPABILITY_TYPES = new Set([
  'thinking',
  'always_thinking',
  'image_in',
  'video_in',
]);

const DEFAULT_KIMI_CONFIG = {
  mode: 'local',
  activeProfile: '',
  profiles: [],
};

function sanitizeCodebuddyProfile(rawProfile) {
  return {
    name: String(rawProfile?.name || '').trim(),
    authToken: String(rawProfile?.authToken || ''),
    apiKey: String(rawProfile?.apiKey || ''),
  };
}

function loadAgentModelPreferences() {
  try {
    const value = JSON.parse(fs.readFileSync(AGENT_MODEL_PREFERENCES_PATH, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function getRememberedAgentModel(agent) {
  const model = loadAgentModelPreferences()[normalizeAgent(agent)];
  return typeof model === 'string' ? model.trim() : '';
}

function rememberAgentModel(agent, model) {
  const normalizedAgent = normalizeAgent(agent);
  const normalizedModel = String(model || '').trim();
  if (!normalizedModel) return;
  const preferences = loadAgentModelPreferences();
  preferences[normalizedAgent] = normalizedModel;
  fs.writeFileSync(AGENT_MODEL_PREFERENCES_PATH, JSON.stringify(preferences, null, 2));

  for (const file of fs.readdirSync(SESSIONS_DIR).filter((entry) => entry.endsWith('.json'))) {
    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const session = normalizeSession(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      if (getSessionAgent(session) !== normalizedAgent || session.model === normalizedModel) continue;
      session.model = normalizedModel;
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
    } catch {}
  }
}

function normalizeKimiCapabilityList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  const seen = new Set();
  for (const item of rawList) {
    const value = String(item || '').trim();
    if (!value || !KIMI_CAPABILITY_TYPES.has(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sanitizeKimiModelEntry(rawModel) {
  const name = String(rawModel?.name || '').trim();
  const model = String(rawModel?.model || '').trim();
  const parsedContext = parseInt(rawModel?.maxContextSize, 10);
  return {
    name,
    model,
    maxContextSize: Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : 262144,
    capabilities: normalizeKimiCapabilityList(rawModel?.capabilities),
  };
}

function sanitizeKimiProfile(rawProfile) {
  const providerTypeRaw = String(rawProfile?.providerType || '').trim();
  const providerType = KIMI_PROVIDER_TYPES.has(providerTypeRaw) ? providerTypeRaw : 'kimi';
  const models = [];
  const seenNames = new Set();
  for (const item of Array.isArray(rawProfile?.models) ? rawProfile.models : []) {
    const model = sanitizeKimiModelEntry(item);
    if (!model.name || !model.model || seenNames.has(model.name)) continue;
    seenNames.add(model.name);
    models.push(model);
  }
  let defaultModel = String(rawProfile?.defaultModel || '').trim();
  if (models.length > 0 && !models.some((model) => model.name === defaultModel)) {
    defaultModel = models[0].name;
  }
  return {
    name: String(rawProfile?.name || '').trim(),
    providerType,
    apiKey: String(rawProfile?.apiKey || ''),
    apiBase: String(rawProfile?.apiBase || '').trim(),
    defaultModel,
    models,
    services: {
      searchBase: String(rawProfile?.services?.searchBase || '').trim(),
      searchApiKey: String(rawProfile?.services?.searchApiKey || ''),
      fetchBase: String(rawProfile?.services?.fetchBase || '').trim(),
      fetchApiKey: String(rawProfile?.services?.fetchApiKey || ''),
    },
  };
}

function loadModelConfig() {
  try {
    if (fs.existsSync(MODEL_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
      if (!config.localSnapshot) config.localSnapshot = {};
      return config;
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_MODEL_CONFIG));
}

function saveModelConfig(config) {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadCodexConfig() {
  try {
    if (fs.existsSync(CODEX_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CODEX_CONFIG_PATH, 'utf8'));
      return {
        mode: raw.mode === 'custom' ? 'custom' : 'local',
        activeProfile: raw.activeProfile || '',
        profiles: Array.isArray(raw.profiles) ? raw.profiles.map((profile) => ({
          name: String(profile?.name || '').trim(),
          apiKey: String(profile?.apiKey || ''),
          apiBase: String(profile?.apiBase || '').trim(),
        })).filter((profile) => profile.name) : [],
        enableSearch: false,
        supportsSearch: false,
        storedEnableSearch: !!raw.enableSearch,
        localSnapshot: raw.localSnapshot || {},
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CODEX_CONFIG));
}

function loadKimiConfig() {
  try {
    if (fs.existsSync(KIMI_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(KIMI_CONFIG_PATH, 'utf8'));
      const profiles = Array.isArray(raw?.profiles)
        ? raw.profiles.map((profile) => sanitizeKimiProfile(profile)).filter((profile) => profile.name)
        : [];
      const activeProfile = String(raw?.activeProfile || '').trim();
      return {
        mode: raw?.mode === 'custom' ? 'custom' : 'local',
        activeProfile: profiles.some((profile) => profile.name === activeProfile) ? activeProfile : '',
        profiles,
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_KIMI_CONFIG));
}

function loadCodebuddyConfig() {
  try {
    if (fs.existsSync(CODEBUDDY_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CODEBUDDY_CONFIG_PATH, 'utf8'));
      const profiles = Array.isArray(raw?.profiles)
        ? raw.profiles.map((profile) => sanitizeCodebuddyProfile(profile)).filter((profile) => profile.name)
        : [];
      const activeProfile = String(raw?.activeProfile || '').trim();
      return {
        mode: raw?.mode === 'custom' ? 'custom' : 'local',
        activeProfile: profiles.some((profile) => profile.name === activeProfile) ? activeProfile : '',
        profiles,
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_CODEBUDDY_CONFIG));
}

function saveCodexConfig(config) {
  fs.writeFileSync(CODEX_CONFIG_PATH, JSON.stringify({
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: Array.isArray(config.profiles) ? config.profiles.map((profile) => ({
      name: String(profile?.name || '').trim(),
      apiKey: String(profile?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
    })).filter((profile) => profile.name) : [],
    enableSearch: false,
  }, null, 2));
}

function saveKimiConfig(config) {
  const profiles = Array.isArray(config?.profiles)
    ? config.profiles.map((profile) => sanitizeKimiProfile(profile)).filter((profile) => profile.name)
    : [];
  const activeProfile = String(config?.activeProfile || '').trim();
  fs.writeFileSync(KIMI_CONFIG_PATH, JSON.stringify({
    mode: config?.mode === 'custom' ? 'custom' : 'local',
    activeProfile: profiles.some((profile) => profile.name === activeProfile) ? activeProfile : '',
    profiles,
  }, null, 2));
}

function saveCodebuddyConfig(config) {
  const profiles = Array.isArray(config?.profiles)
    ? config.profiles.map((profile) => sanitizeCodebuddyProfile(profile)).filter((profile) => profile.name)
    : [];
  const activeProfile = String(config?.activeProfile || '').trim();
  fs.writeFileSync(CODEBUDDY_CONFIG_PATH, JSON.stringify({
    mode: config?.mode === 'custom' ? 'custom' : 'local',
    activeProfile: profiles.some((profile) => profile.name === activeProfile) ? activeProfile : '',
    profiles,
  }, null, 2));
}

function getCodexConfigMasked() {
  const config = loadCodexConfig();
  return {
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
    })),
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: !!config.storedEnableSearch,
    localSnapshot: config.localSnapshot || {},
  };
}

function maskSecret(str) {
  if (!str || str.length <= 8) return str ? '****' : '';
  return str.slice(0, 4) + '****' + str.slice(-4);
}

function getKimiConfigMasked() {
  const config = loadKimiConfig();
  return {
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      providerType: profile.providerType || 'kimi',
      apiKey: maskSecret(profile.apiKey),
      apiBase: profile.apiBase || '',
      defaultModel: profile.defaultModel || '',
      models: (profile.models || []).map((model) => ({
        name: model.name,
        model: model.model,
        maxContextSize: model.maxContextSize,
        capabilities: Array.isArray(model.capabilities) ? [...model.capabilities] : [],
      })),
      services: {
        searchBase: profile.services?.searchBase || '',
        searchApiKey: maskSecret(profile.services?.searchApiKey || ''),
        fetchBase: profile.services?.fetchBase || '',
        fetchApiKey: maskSecret(profile.services?.fetchApiKey || ''),
      },
    })),
  };
}

function getCodebuddyConfigMasked() {
  const config = loadCodebuddyConfig();
  return {
    mode: config.mode === 'custom' ? 'custom' : 'local',
    activeProfile: config.activeProfile || '',
    profiles: (config.profiles || []).map((profile) => ({
      name: profile.name,
      authToken: maskSecret(profile.authToken),
      apiKey: maskSecret(profile.apiKey),
    })),
  };
}

function getModelConfigMasked() {
  const config = loadModelConfig();
  return {
    mode: config.mode,
    activeTemplate: config.activeTemplate,
    templates: (config.templates || []).map(t => ({
      name: t.name,
      apiKey: maskSecret(t.apiKey),
      apiBase: t.apiBase || '',
      defaultModel: t.defaultModel || '',
      opusModel: t.opusModel || '',
      sonnetModel: t.sonnetModel || '',
      haikuModel: t.haikuModel || '',
    })),
    localSnapshot: config.localSnapshot || {},
  };
}

// === Dev Config (GitHub / SSH) ===
const DEV_CONFIG_PATH = path.join(CONFIG_DIR, 'dev.json');
const DEFAULT_DEV_CONFIG = { github: { token: '', repos: [] }, ssh: { hosts: [] } };

function loadDevConfig() {
  try {
    if (fs.existsSync(DEV_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DEV_CONFIG_PATH, 'utf8'));
      return {
        github: {
          token: raw.github?.token || '',
          repos: Array.isArray(raw.github?.repos) ? raw.github.repos : [],
        },
        ssh: {
          hosts: Array.isArray(raw.ssh?.hosts) ? raw.ssh.hosts : [],
        },
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_DEV_CONFIG));
}

function saveDevConfig(config) {
  fs.writeFileSync(DEV_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getDevConfigMasked() {
  const config = loadDevConfig();
  return {
    github: {
      token: maskSecret(config.github.token),
      repos: config.github.repos || [],
    },
    ssh: {
      hosts: (config.ssh.hosts || []).map(h => ({
        id: h.id || '',
        name: h.name || '',
        host: h.host || '',
        port: h.port || 22,
        user: h.user || '',
        authType: h.authType || 'key',
        identityFile: h.identityFile || '',
        password: maskSecret(h.password || ''),
        description: h.description || '',
      })),
    },
  };
}

function handleSaveDevConfig(ws, msg) {
  if (!msg.config || typeof msg.config !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的开发者配置' });
  }
  const current = loadDevConfig();
  let token = String(msg.config.github?.token || '');
  // Mask merge: keep existing if masked
  if (token.includes('****')) token = current.github.token;
  const repos = Array.isArray(msg.config.github?.repos) ? msg.config.github.repos.map(r => ({
    id: r.id || ('r_' + crypto.randomBytes(4).toString('hex')),
    name: String(r.name || '').trim(),
    url: String(r.url || '').trim(),
    branch: String(r.branch || 'main').trim(),
    notes: String(r.notes || '').trim(),
  })).filter(r => r.name && r.url) : [];
  const oldHosts = Array.isArray(current.ssh?.hosts) ? current.ssh.hosts : [];
  const hosts = Array.isArray(msg.config.ssh?.hosts) ? msg.config.ssh.hosts.map(h => {
    const old = oldHosts.find(oh => oh.id === h.id || oh.name === h.name);
    const authType = h.authType === 'password' ? 'password' : 'key';
    let password = String(h.password || '');
    if (password.includes('****')) password = old?.password || '';
    return {
      id: h.id || ('h_' + crypto.randomBytes(4).toString('hex')),
      name: String(h.name || '').trim(),
      host: String(h.host || '').trim(),
      port: parseInt(h.port) || 22,
      user: String(h.user || '').trim(),
      authType,
      identityFile: authType === 'key' ? String(h.identityFile || '').trim() : '',
      password: authType === 'password' ? password : '',
      description: String(h.description || '').trim(),
    };
  }).filter(h => h.name && h.host) : [];
  const merged = { github: { token, repos }, ssh: { hosts } };
  saveDevConfig(merged);
  plog('INFO', 'dev_config_saved', { repoCount: repos.length, hostCount: hosts.length });
  wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '开发者配置已保存' });
}

const CODEX_RUNTIME_HOME = path.join(CONFIG_DIR, 'codex-runtime-home');
const KIMI_RUNTIME_DIR = path.join(CONFIG_DIR, 'kimi-runtime');

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function prepareCodexCustomRuntime(config) {
  if (!config || config.mode !== 'custom') return { mode: 'local' };
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const activeProfile = profiles.find((profile) => profile.name === config.activeProfile) || null;
  if (!activeProfile) {
    return { error: 'Codex 自定义配置缺少已激活的 profile。请先在设置中创建并激活一个 API 配置。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Codex profile「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }

  fs.mkdirSync(CODEX_RUNTIME_HOME, { recursive: true });
  const configToml = [
    'preferred_auth_method = "apikey"',
    'model_provider = "openai_compat"',
    '',
    '[model_providers.openai_compat]',
    `name = ${tomlString(activeProfile.name || 'OpenAI Compat')}`,
    `base_url = ${tomlString(activeProfile.apiBase)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(CODEX_RUNTIME_HOME, 'config.toml'), configToml);

  return {
    mode: 'custom',
    homeDir: CODEX_RUNTIME_HOME,
    apiKey: activeProfile.apiKey,
    apiBase: activeProfile.apiBase,
    profileName: activeProfile.name,
  };
}

function resolveActiveKimiProfile(config) {
  if (!config || config.mode !== 'custom') return null;
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  return profiles.find((profile) => profile.name === config.activeProfile) || null;
}

function buildKimiRuntimeConfig(profile) {
  const defaultModel = profile.defaultModel || profile.models[0]?.name || '';
  const providerName = 'cc-web';
  const config = {
    default_model: defaultModel,
    providers: {
      [providerName]: {
        type: profile.providerType || 'kimi',
        base_url: profile.apiBase,
        api_key: profile.apiKey,
      },
    },
    models: {},
  };

  for (const model of profile.models || []) {
    const entry = {
      provider: providerName,
      model: model.model,
      max_context_size: model.maxContextSize,
    };
    if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
      entry.capabilities = [...model.capabilities];
    }
    config.models[model.name] = entry;
  }

  const searchBase = String(profile.services?.searchBase || '').trim();
  const searchApiKey = String(profile.services?.searchApiKey || '');
  const fetchBase = String(profile.services?.fetchBase || '').trim();
  const fetchApiKey = String(profile.services?.fetchApiKey || '');
  if (searchBase && searchApiKey) {
    config.services = config.services || {};
    config.services.moonshot_search = {
      base_url: searchBase,
      api_key: searchApiKey,
    };
  }
  if (fetchBase && fetchApiKey) {
    config.services = config.services || {};
    config.services.moonshot_fetch = {
      base_url: fetchBase,
      api_key: fetchApiKey,
    };
  }

  return config;
}

function prepareKimiCustomRuntime(config) {
  if (!config || config.mode !== 'custom') return { mode: 'local' };
  const activeProfile = resolveActiveKimiProfile(config);
  if (!activeProfile) {
    return { error: 'Kimi 自定义配置缺少已激活的 Profile。请先在设置中创建并激活一个 Kimi Profile。' };
  }
  if (!activeProfile.apiKey || !activeProfile.apiBase) {
    return { error: `Kimi Profile「${activeProfile.name}」缺少 API Key 或 API Base URL。` };
  }
  if (!Array.isArray(activeProfile.models) || activeProfile.models.length === 0) {
    return { error: `Kimi Profile「${activeProfile.name}」至少需要配置一个模型。` };
  }
  if (!activeProfile.defaultModel || !activeProfile.models.some((model) => model.name === activeProfile.defaultModel)) {
    return { error: `Kimi Profile「${activeProfile.name}」缺少有效的默认模型。` };
  }

  const searchBase = String(activeProfile.services?.searchBase || '').trim();
  const searchApiKey = String(activeProfile.services?.searchApiKey || '');
  if ((searchBase && !searchApiKey) || (!searchBase && searchApiKey)) {
    return { error: `Kimi Profile「${activeProfile.name}」的搜索服务配置不完整。` };
  }
  const fetchBase = String(activeProfile.services?.fetchBase || '').trim();
  const fetchApiKey = String(activeProfile.services?.fetchApiKey || '');
  if ((fetchBase && !fetchApiKey) || (!fetchBase && fetchApiKey)) {
    return { error: `Kimi Profile「${activeProfile.name}」的抓取服务配置不完整。` };
  }

  fs.mkdirSync(KIMI_RUNTIME_DIR, { recursive: true });
  const configFilePath = path.join(KIMI_RUNTIME_DIR, 'config.json');
  fs.writeFileSync(configFilePath, JSON.stringify(buildKimiRuntimeConfig(activeProfile), null, 2));

  return {
    mode: 'custom',
    configFilePath,
    profileName: activeProfile.name,
    defaultModel: activeProfile.defaultModel,
  };
}

// Read ~/.claude.json for model name overrides
function loadClaudeJsonModelMap() {
  try {
    const p = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const env = raw?.env || {};
    const map = {};
    // Append [1m] to opus/sonnet for 1M context window; haiku uses model name as-is
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) map.opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) map.sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL + '[1m]';
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) map.haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    // Fallback: ANTHROPIC_MODEL maps to opus slot
    if (!map.opus && env.ANTHROPIC_MODEL) map.opus = env.ANTHROPIC_MODEL + '[1m]';
    return Object.keys(map).length > 0 ? map : null;
  } catch {
    return null;
  }
}

// Apply model config to runtime MODEL_MAP only (env vars are injected per-spawn, not here)
const CLAUDE_SETTINGS_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json');
const SETTINGS_API_KEYS = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_REASONING_MODEL'];

function applyCustomTemplateToSettings(tpl) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch {}
  const cleanedEnv = {};
  for (const [k, v] of Object.entries(settings.env || {})) {
    if (!SETTINGS_API_KEYS.includes(k)) cleanedEnv[k] = v;
  }
  if (tpl.apiKey)       { cleanedEnv.ANTHROPIC_AUTH_TOKEN = tpl.apiKey; }
  if (tpl.apiBase)      cleanedEnv.ANTHROPIC_BASE_URL = tpl.apiBase;
  if (tpl.defaultModel) cleanedEnv.ANTHROPIC_MODEL = tpl.defaultModel;
  if (tpl.opusModel)    cleanedEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = tpl.opusModel;
  if (tpl.sonnetModel)  cleanedEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = tpl.sonnetModel;
  if (tpl.haikuModel)   cleanedEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = tpl.haikuModel;
  settings.env = cleanedEnv;
  // 原子写入：先写临时文件再 rename，避免 Claude 子进程读到写了一半的文件
  const tmpPath = CLAUDE_SETTINGS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function applyModelConfig() {
  const config = loadModelConfig();
  if (config.mode === 'custom' && config.activeTemplate) {
    const tpl = (config.templates || []).find(t => t.name === config.activeTemplate);
    if (tpl) {
      if (tpl.opusModel) MODEL_MAP.opus = tpl.opusModel.endsWith('[1m]') ? tpl.opusModel : tpl.opusModel + '[1m]';
      if (tpl.sonnetModel) MODEL_MAP.sonnet = tpl.sonnetModel.endsWith('[1m]') ? tpl.sonnetModel : tpl.sonnetModel + '[1m]';
      if (tpl.haikuModel) MODEL_MAP.haiku = tpl.haikuModel;
      return;
    }
  }
  // mode === 'local': read model names from ~/.claude.json
  const localMap = loadClaudeJsonModelMap();
  if (localMap) {
    if (localMap.opus) MODEL_MAP.opus = localMap.opus;
    if (localMap.sonnet) MODEL_MAP.sonnet = localMap.sonnet;
    if (localMap.haiku) MODEL_MAP.haiku = localMap.haiku;
  }
}

// Apply on startup
applyModelConfig();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// === Utility Functions ===

function wsSend(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9\-]/g, '');
}

function sessionPath(id) {
  return path.join(SESSIONS_DIR, `${sanitizeId(id)}.json`);
}

function runDir(sessionId) {
  return path.join(SESSIONS_DIR, `${sanitizeId(sessionId)}-run`);
}

function attachmentDataPath(id, ext = '') {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}${ext}`);
}

function attachmentMetaPath(id) {
  return path.join(ATTACHMENTS_DIR, `${sanitizeId(id)}.json`);
}

function safeFilename(name) {
  return String(name || 'image')
    .replace(/[\/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extFromMime(mime) {
  switch (mime) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    default: return '';
  }
}

function loadAttachmentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(attachmentMetaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveAttachmentMeta(meta) {
  fs.writeFileSync(attachmentMetaPath(meta.id), JSON.stringify(meta, null, 2));
}

function removeAttachmentById(id) {
  const meta = loadAttachmentMeta(id);
  const paths = new Set([attachmentMetaPath(id)]);
  if (meta?.path) paths.add(meta.path);
  for (const filePath of paths) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function currentAttachmentState(meta) {
  if (!meta) return 'missing';
  const expiresAtMs = new Date(meta.expiresAt || 0).getTime();
  if (expiresAtMs && Date.now() > expiresAtMs) return 'expired';
  if (!meta.path || !fs.existsSync(meta.path)) return 'missing';
  return 'available';
}

function normalizeMessageAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const normalized = [];
  for (const attachment of attachments) {
    const id = sanitizeId(attachment?.id || '');
    if (!id) continue;
    const meta = loadAttachmentMeta(id);
    const state = currentAttachmentState(meta);
    if (state === 'expired') removeAttachmentById(id);
    normalized.push({
      id,
      kind: 'image',
      filename: meta?.filename || attachment?.filename || 'image',
      mime: meta?.mime || attachment?.mime || 'image/png',
      size: meta?.size || attachment?.size || 0,
      createdAt: meta?.createdAt || attachment?.createdAt || null,
      expiresAt: meta?.expiresAt || attachment?.expiresAt || null,
      storageState: state === 'available' ? 'available' : 'expired',
    });
  }
  return normalized;
}

function resolveMessageAttachments(attachments) {
  const resolved = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    if (attachment.storageState !== 'available') continue;
    const meta = loadAttachmentMeta(attachment.id);
    if (!meta?.path || !fs.existsSync(meta.path)) continue;
    resolved.push({
      ...attachment,
      path: meta.path,
    });
  }
  return resolved;
}

function cleanupExpiredAttachments() {
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      const meta = loadAttachmentMeta(id);
      if (!meta || currentAttachmentState(meta) === 'expired') {
        removeAttachmentById(id);
      }
    }
  } catch {}
}

function collectSessionAttachmentIds(session) {
  const ids = new Set();
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
      const id = sanitizeId(attachment?.id || '');
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

function extractBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

const INITIAL_HISTORY_COUNT = 12;
const HISTORY_CHUNK_SIZE = 24;

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  session.agent = normalizeAgent(session.agent);
  getAgentIds().forEach((agentId) => {
    const runtimeField = getRuntimeSessionField(agentId);
    if (!Object.prototype.hasOwnProperty.call(session, runtimeField)) session[runtimeField] = null;
  });
  if (!Object.prototype.hasOwnProperty.call(session, 'totalCost')) session.totalCost = 0;
  if (!Object.prototype.hasOwnProperty.call(session, 'totalUsage') || !session.totalUsage) {
    session.totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  }
  if (!Object.prototype.hasOwnProperty.call(session.totalUsage, 'contextTokens')) {
    session.totalUsage.contextTokens = 0;
  }
  if (!Object.prototype.hasOwnProperty.call(session, 'taskMode')) session.taskMode = 'local';
  if (!Object.prototype.hasOwnProperty.call(session, 'sshHostId')) session.sshHostId = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'remoteCwd')) session.remoteCwd = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'codebuddyProfile')) session.codebuddyProfile = '';
  if (!Object.prototype.hasOwnProperty.call(session, 'messages')) session.messages = [];
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const nextMessage = { ...message };
      if (nextMessage.attachments) {
        nextMessage.attachments = normalizeMessageAttachments(nextMessage.attachments);
      }
      if (nextMessage.role === 'assistant') {
        if (!Array.isArray(nextMessage.toolCalls)) nextMessage.toolCalls = [];
        if (!Array.isArray(nextMessage.steps) || nextMessage.steps.length === 0) {
          const steps = [];
          if (typeof nextMessage.content === 'string' && nextMessage.content.trim()) {
            steps.push({ type: 'text', content: nextMessage.content });
          }
          nextMessage.toolCalls.forEach((tool) => {
            if (!tool || typeof tool !== 'object') return;
            steps.push({ type: 'tool_call', ...tool });
          });
          nextMessage.steps = steps;
        }
      }
      return nextMessage;
    });
  }
  return session;
}

function getSessionAgent(session) {
  return normalizeAgent(session?.agent);
}

function isClaudeSession(session) {
  return getSessionAgent(session) === 'claude';
}

function getRuntimeSessionId(session) {
  if (!session) return null;
  const runtimeField = getRuntimeSessionField(getSessionAgent(session));
  return session[runtimeField] || null;
}

function setRuntimeSessionId(session, runtimeId) {
  if (!session) return;
  const runtimeField = getRuntimeSessionField(getSessionAgent(session));
  session[runtimeField] = runtimeId || null;
}

function clearRuntimeSessionId(session) {
  setRuntimeSessionId(session, null);
}

function loadSession(id) {
  try {
    const session = normalizeSession(JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')));
    const rememberedModel = getRememberedAgentModel(getSessionAgent(session));
    if (rememberedModel) session.model = rememberedModel;
    return session;
  } catch {
    return null;
  }
}

function saveSession(session) {
  normalizeSession(session);
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function normalizeAssistantContent(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function mergeAssistantMessage(target, incoming) {
  let changed = false;
  if ((!target.content || !String(target.content).trim()) && incoming.content) {
    target.content = incoming.content;
    changed = true;
  }
  if ((incoming.toolCalls || []).length > (target.toolCalls || []).length) {
    target.toolCalls = incoming.toolCalls;
    changed = true;
  }
  if ((incoming.steps || []).length > (target.steps || []).length) {
    target.steps = incoming.steps;
    changed = true;
  }
  if (!target.timestamp && incoming.timestamp) {
    target.timestamp = incoming.timestamp;
    changed = true;
  }
  if (!Number.isFinite(target.durationMs) && Number.isFinite(incoming.durationMs)) {
    target.durationMs = incoming.durationMs;
    changed = true;
  }
  return changed;
}

function getLocalSessionWorkspace(sessionId) {
  const session = sessionId ? loadSession(sessionId) : null;
  const cwd = session?.cwd || activeProcesses.get(sessionId)?.cwd || '';
  if (!session || !cwd || session.taskMode === 'remote' || !fs.existsSync(cwd)) return null;
  return { session, cwd: path.resolve(cwd) };
}

function handleGitStatus(ws, sessionId) {
  const workspace = getLocalSessionWorkspace(sessionId);
  if (!workspace) {
    return wsSend(ws, { type: 'git_status', sessionId, available: false, files: [] });
  }
  const { cwd } = workspace;

  try {
    const branchResult = spawnSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const statusResult = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (statusResult.status !== 0) {
      return wsSend(ws, { type: 'git_status', sessionId, available: false, files: [] });
    }

    const numstatResult = spawnSync('git', ['diff', '--numstat', 'HEAD', '--'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lineStats = new Map();
    String(numstatResult.stdout || '').split(/\r?\n/).forEach((line) => {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!match) return;
      lineStats.set(match[3], {
        additions: match[1] === '-' ? null : Number(match[1]),
        deletions: match[2] === '-' ? null : Number(match[2]),
      });
    });

    const entries = String(statusResult.stdout || '').split('\0').filter(Boolean);
    const files = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const code = entry.slice(0, 2);
      const filePath = entry.slice(3);
      const renamed = code.includes('R') || code.includes('C');
      const originalPath = renamed ? entries[++index] || '' : '';
      let status = 'modified';
      if (code === '??') status = 'untracked';
      else if (code.includes('D')) status = 'deleted';
      else if (code.includes('A')) status = 'added';
      else if (renamed) status = 'renamed';
      let stats = lineStats.get(filePath) || {};
      if (status === 'untracked') {
        try {
          const target = path.resolve(cwd, filePath);
          const fileStat = fs.statSync(target);
          if (fileStat.isFile() && fileStat.size <= 2 * 1024 * 1024) {
            const content = fs.readFileSync(target, 'utf8');
            stats = { additions: content ? content.split(/\r?\n/).length : 0, deletions: 0 };
          }
        } catch {}
      }
      files.push({
        path: filePath,
        originalPath,
        code,
        status,
        staged: code[0] !== ' ' && code[0] !== '?',
        additions: Number.isFinite(stats.additions) ? stats.additions : null,
        deletions: Number.isFinite(stats.deletions) ? stats.deletions : null,
      });
    }
    wsSend(ws, {
      type: 'git_status',
      sessionId,
      available: true,
      branch: String(branchResult.stdout || '').trim(),
      files,
    });
  } catch (error) {
    wsSend(ws, { type: 'git_status', sessionId, available: false, files: [], error: error.message });
  }
}

function handleListWorkspaceFiles(ws, sessionId, relativePath = '') {
  const workspace = getLocalSessionWorkspace(sessionId);
  if (!workspace) return wsSend(ws, { type: 'workspace_files', sessionId, available: false, entries: [] });
  const target = path.resolve(workspace.cwd, String(relativePath || ''));
  if (!isPathInside(workspace.cwd, target)) {
    return wsSend(ws, { type: 'workspace_files', sessionId, available: false, entries: [], error: '路径越界' });
  }
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .map((entry) => {
        const fullPath = path.join(target, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          path: path.relative(workspace.cwd, fullPath).replace(/\\/g, '/'),
          directory: entry.isDirectory(),
          size: entry.isFile() ? stat.size : null,
        };
      })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'))
      .slice(0, 500);
    wsSend(ws, {
      type: 'workspace_files',
      sessionId,
      available: true,
      path: path.relative(workspace.cwd, target).replace(/\\/g, '/'),
      entries,
    });
  } catch (error) {
    wsSend(ws, { type: 'workspace_files', sessionId, available: false, entries: [], error: error.message });
  }
}

function handleReadWorkspaceFile(ws, sessionId, relativePath) {
  const workspace = getLocalSessionWorkspace(sessionId);
  if (!workspace) return wsSend(ws, { type: 'workspace_file', sessionId, available: false });
  const target = path.resolve(workspace.cwd, String(relativePath || ''));
  if (!isPathInside(workspace.cwd, target)) {
    return wsSend(ws, { type: 'workspace_file', sessionId, available: false, error: '路径越界' });
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) throw new Error('目标不是文件');
    if (stat.size > 1024 * 1024) throw new Error('文件超过 1MB，无法预览');
    const buffer = fs.readFileSync(target);
    if (buffer.includes(0)) throw new Error('二进制文件无法预览');
    wsSend(ws, {
      type: 'workspace_file',
      sessionId,
      available: true,
      path: path.relative(workspace.cwd, target).replace(/\\/g, '/'),
      content: buffer.toString('utf8'),
    });
  } catch (error) {
    wsSend(ws, { type: 'workspace_file', sessionId, available: false, path: relativePath, error: error.message });
  }
}

function handleGitHistory(ws, msg) {
  const sessionId = msg?.sessionId;
  const workspace = getLocalSessionWorkspace(sessionId);
  if (!workspace) {
    return wsSend(ws, { type: 'git_history', sessionId, requestId: msg?.requestId, available: false, commits: [], hasMore: false });
  }
  const result = readGitHistory(workspace.cwd, { offset: msg?.offset, limit: msg?.limit });
  wsSend(ws, { type: 'git_history', sessionId, requestId: msg?.requestId, ...result });
}

function handleWorkspaceDiff(ws, msg) {
  const sessionId = msg?.sessionId;
  const workspace = getLocalSessionWorkspace(sessionId);
  if (!workspace) {
    return wsSend(ws, { type: 'workspace_diff', sessionId, available: false, diff: '' });
  }
  const result = readGitFileDiff(workspace.cwd, {
    path: msg?.path,
    originalPath: msg?.originalPath,
    status: msg?.status,
    contextLines: 3,
  });
  wsSend(ws, { type: 'workspace_diff', sessionId, ...result });
}

function mergeSequentialAssistantMessage(target, incoming) {
  const targetContent = normalizeAssistantContent(target.content);
  const incomingContent = normalizeAssistantContent(incoming.content);
  if (incomingContent && incomingContent !== targetContent) {
    target.content = targetContent ? `${target.content}\n\n${incoming.content}` : incoming.content;
  }
  if (Array.isArray(incoming.toolCalls) && incoming.toolCalls.length > 0) {
    if (!Array.isArray(target.toolCalls)) target.toolCalls = [];
    target.toolCalls.push(...incoming.toolCalls);
  }
  if (Array.isArray(incoming.steps) && incoming.steps.length > 0) {
    if (!Array.isArray(target.steps)) target.steps = [];
    const firstIncoming = incoming.steps[0];
    const lastTarget = target.steps[target.steps.length - 1];
    if (lastTarget?.type === 'text' && firstIncoming?.type === 'text') {
      lastTarget.content = `${lastTarget.content || ''}\n\n${firstIncoming.content || ''}`;
      target.steps.push(...incoming.steps.slice(1));
    } else {
      target.steps.push(...incoming.steps);
    }
  }
  if (Number.isFinite(incoming.durationMs)) {
    target.durationMs = (Number.isFinite(target.durationMs) ? target.durationMs : 0) + incoming.durationMs;
  }
}

function upsertTrailingAssistantMessage(session, message) {
  if (!session) return { changed: false, appended: false };
  if (!Array.isArray(session.messages)) session.messages = [];

  const incoming = {
    role: 'assistant',
    content: String(message?.content || ''),
    toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : [],
    steps: Array.isArray(message?.steps) ? message.steps : [],
    timestamp: message?.timestamp || new Date().toISOString(),
    durationMs: Number.isFinite(message?.durationMs) ? Math.max(0, Math.floor(message.durationMs)) : null,
  };
  if (!normalizeAssistantContent(incoming.content) && incoming.steps.length === 0 && incoming.toolCalls.length === 0) {
    return { changed: false, appended: false };
  }

  const last = session.messages[session.messages.length - 1];
  if (last?.role === 'assistant') {
    const sameContent = normalizeAssistantContent(last.content) && normalizeAssistantContent(last.content) === normalizeAssistantContent(incoming.content);
    if (sameContent) {
      return {
        changed: mergeAssistantMessage(last, incoming),
        appended: false,
      };
    }
    mergeSequentialAssistantMessage(last, incoming);
    return { changed: true, appended: false };
  }

  session.messages.push(incoming);
  return { changed: true, appended: true };
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function pickFirstValidIsoTimestamp(...values) {
  for (const value of values) {
    const iso = toIsoTimestamp(value);
    if (iso) return iso;
  }
  return null;
}

function getFileMtimeIso(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function repairDuplicateAssistantMessages() {
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const session = loadSession(file.slice(0, -5));
        if (!session || !Array.isArray(session.messages) || session.messages.length < 2) continue;
        const repaired = [];
        let changed = false;
        for (const message of session.messages) {
          if (message?.role !== 'assistant') {
            repaired.push(message);
            continue;
          }
          const tempSession = { messages: repaired };
          const result = upsertTrailingAssistantMessage(tempSession, message);
          if (!result.appended) changed = true;
        }
        if (changed || repaired.length !== session.messages.length) {
          session.messages = repaired;
          saveSession(session);
        }
      } catch {}
    }
  } catch {}
}

function modelShortName(fullModel) {
  if (!fullModel) return null;
  const entry = Object.entries(MODEL_MAP).find(([, v]) => v === fullModel);
  return entry ? entry[0] : null;
}

function sessionModelLabel(session) {
  if (!session?.model) return null;
  return isClaudeSession(session) ? (modelShortName(session.model) || session.model) : session.model;
}

function splitHistoryMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= INITIAL_HISTORY_COUNT) {
    return { recentMessages: list, olderChunks: [] };
  }
  const recentMessages = list.slice(-INITIAL_HISTORY_COUNT);
  const older = list.slice(0, -INITIAL_HISTORY_COUNT);
  const olderChunks = [];
  for (let end = older.length; end > 0; end -= HISTORY_CHUNK_SIZE) {
    const start = Math.max(0, end - HISTORY_CHUNK_SIZE);
    olderChunks.push(older.slice(start, end));
  }
  return { recentMessages, olderChunks };
}

const IS_WIN = process.platform === 'win32';
const RUNTIME_IDENTITY_AGENTS = new Set(['claude', 'codex', 'codebuddy', 'kimi', 'opencode']);

function normalizeProcessStartMarker(value) {
  const marker = String(value || '').trim();
  return marker || null;
}

function getWindowsProcessSnapshot(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    '$start = if ($p.CreationDate) { [System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString(\'o\') } else { \'\' }',
    '[pscustomobject]@{ startMarker = $start; commandLine = [string]($p.CommandLine ?? \'\') } | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return { running: false, startMarker: null, commandLine: '' };
    }
    const parsed = JSON.parse(String(result.stdout || '{}').trim() || '{}');
    return {
      running: true,
      startMarker: normalizeProcessStartMarker(parsed?.startMarker),
      commandLine: String(parsed?.commandLine || '').trim(),
    };
  } catch {
    return { running: false, startMarker: null, commandLine: '' };
  }
}

function getPosixProcessSnapshot(pid) {
  try {
    const startResult = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    const commandResult = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    return {
      running: startResult.status === 0 || commandResult.status === 0,
      startMarker: normalizeProcessStartMarker(startResult.stdout),
      commandLine: String(commandResult.stdout || '').trim(),
    };
  } catch {
    return { running: false, startMarker: null, commandLine: '' };
  }
}

function getProcessSnapshot(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { running: false, startMarker: null, commandLine: '' };
  }
  return IS_WIN ? getWindowsProcessSnapshot(numericPid) : getPosixProcessSnapshot(numericPid);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid, force = false) {
  try {
    if (IS_WIN) {
      const args = ['/T', '/PID', String(pid)];
      if (force) args.unshift('/F');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {}
}

function shouldValidateRuntimeIdCommandLine(agent, runtimeId) {
  const normalizedAgent = normalizeAgent(agent);
  const marker = String(runtimeId || '').trim();
  return !!marker && RUNTIME_IDENTITY_AGENTS.has(normalizedAgent);
}

function readRunProcessMeta(dir) {
  try {
    const metaPath = path.join(dir, 'process.json');
    let meta = null;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    const pidPath = path.join(dir, 'pid');
    const pidRaw = meta?.pid ?? (fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf8') : '');
    const pid = parseInt(String(pidRaw || '').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      agent: normalizeAgent(meta?.agent || ''),
      runtimeId: String(meta?.runtimeId || '').trim() || null,
      processStartMarker: normalizeProcessStartMarker(meta?.processStartMarker),
      startedAt: Number(meta?.startedAt) || Date.parse(meta?.capturedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

function writeRunProcessMeta(dir, meta) {
  try {
    fs.writeFileSync(path.join(dir, 'process.json'), JSON.stringify({
      pid: Number(meta?.pid) || 0,
      agent: normalizeAgent(meta?.agent || ''),
      runtimeId: String(meta?.runtimeId || '').trim() || null,
      processStartMarker: normalizeProcessStartMarker(meta?.processStartMarker),
      startedAt: Number(meta?.startedAt) || Date.now(),
      capturedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function getTrackedProcessStatus(entry) {
  const pid = Number(entry?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, reason: 'invalid_pid', snapshot: null };
  }
  if (!isProcessRunning(pid)) {
    return { alive: false, reason: 'pid_missing', snapshot: null };
  }

  const expectedStartMarker = normalizeProcessStartMarker(entry?.processStartMarker);
  const runtimeId = String(entry?.runtimeId || '').trim() || null;
  const agent = normalizeAgent(entry?.agent || '');
  const needsSnapshot = !!expectedStartMarker || shouldValidateRuntimeIdCommandLine(agent, runtimeId);

  if (!needsSnapshot) {
    return { alive: true, reason: 'pid_exists', snapshot: null };
  }

  const snapshot = getProcessSnapshot(pid);
  if (!snapshot.running) {
    return { alive: false, reason: 'pid_missing', snapshot };
  }
  if (expectedStartMarker) {
    if (!snapshot.startMarker) {
      return { alive: false, reason: 'start_marker_unavailable', snapshot };
    }
    if (snapshot.startMarker !== expectedStartMarker) {
      return { alive: false, reason: 'start_marker_mismatch', snapshot };
    }
  } else if (shouldValidateRuntimeIdCommandLine(agent, runtimeId)) {
    const commandLine = String(snapshot.commandLine || '');
    if (!commandLine) {
      return { alive: false, reason: 'runtime_id_unavailable', snapshot };
    }
    if (!commandLine.includes(runtimeId)) {
      return { alive: false, reason: 'runtime_id_mismatch', snapshot };
    }
  }

  return {
    alive: true,
    reason: expectedStartMarker ? 'start_marker_match' : 'runtime_id_match',
    snapshot,
  };
}

function getLiveProcessStatus(entry) {
  if (entry?.identityCheck) return getTrackedProcessStatus(entry);
  const alive = isProcessRunning(entry?.pid);
  return { alive, reason: alive ? 'pid_exists' : 'pid_missing', snapshot: null };
}

function cleanRunDir(sessionId) {
  const dir = runDir(sessionId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    }
  } catch (error) {
    plog('WARN', 'run_dir_cleanup_fail', {
      sessionId: String(sessionId || '').slice(0, 8),
      dir,
      error: String(error?.message || error || 'unknown'),
    });
  }
}

function sendSessionList(ws) {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        sessions.push({
          id: s.id,
          title: s.title || 'Untitled',
          cwd: s.cwd || '',
          remoteCwd: s.remoteCwd || '',
          updated: s.updated,
          hasUnread: !!s.hasUnread,
          agent: getSessionAgent(s),
          isRunning: activeProcesses.has(s.id),
        });
      } catch {}
    }
    sessions.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    wsSend(ws, { type: 'session_list', sessions });
  } catch {
    wsSend(ws, { type: 'session_list', sessions: [] });
  }
}

// === File Tailer ===
// Tails a file and calls onLine for each new complete line.
class FileTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = '';
    this.watcher = null;
    this.interval = null;
    this.stopped = false;
  }

  start() {
    this.readNew();
    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.stopped) this.readNew();
      });
      this.watcher.on('error', () => {});
    } catch {}
    // Backup poll every 500ms (fs.watch not always reliable on all systems)
    this.interval = setInterval(() => {
      if (!this.stopped) this.readNew();
    }, 500);
  }

  readNew() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.offset) return;
      const buf = Buffer.alloc(stat.size - this.offset);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset = stat.size;
      this.buffer += buf.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this.onLine(line);
      }
    } catch {}
  }

  stop() {
    this.stopped = true;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }
}

// === Process Lifecycle ===

function firstMeaningfulLine(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function condenseRuntimeError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const usageIndex = lines.findIndex((line) => /^Usage:/i.test(line));
  if (usageIndex >= 0) return lines.slice(0, usageIndex).join(' ');
  return lines.slice(0, 3).join(' ');
}

function appendRuntimeErrorDetail(message, detail) {
  const condensedDetail = condenseRuntimeError(detail);
  if (!condensedDetail) return message;
  if (message.includes(condensedDetail)) return message;
  return `${message} 原始输出：${condensedDetail}`;
}

function isLowSignalRuntimeMessage(text) {
  const condensed = condenseRuntimeError(text);
  if (!condensed) return true;
  return /^(to )?resume (this )?(session|conversation)\b|^to resume this session:|^to continue this (session|conversation):|^resume with\b/i.test(condensed);
}

function runtimeErrorScore(text) {
  const condensed = condenseRuntimeError(text);
  if (!condensed) return Number.NEGATIVE_INFINITY;

  let score = Math.min(12, condensed.length / 24);
  if (isLowSignalRuntimeMessage(condensed)) score -= 50;
  if (/^Usage:|unknown option|unknown flag|unexpected argument/i.test(condensed)) score -= 12;
  if (/HTTP\s*\d{3}|status code[: ]*\d{3}|page not found|bad request|unauthorized|forbidden|too many requests|internal server error|bad gateway|gateway timeout|service unavailable/i.test(condensed)) score += 40;
  if (/error|failed|exception|traceback|timeout|timed out|network|not found|denied|refused|reset|quota|rate limit|invalid|unsupported/i.test(condensed)) score += 24;
  if (/^\{.+\}$/.test(condensed)) score -= 4;
  return score;
}

function pickMostUsefulRuntimeError(candidates = []) {
  const seen = new Set();
  let best = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const text = condenseRuntimeError(item?.text || '');
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ranked = {
      source: item?.source || null,
      text,
      score: runtimeErrorScore(text),
      index: i,
    };
    if (!best
      || ranked.score > best.score
      || (ranked.score === best.score && ranked.index < best.index)) {
      best = ranked;
    }
  }

  return best || { source: null, text: '' };
}

function extractRuntimeOutputDiagnostics(rawText) {
  const rawLines = [];
  const eventErrors = [];

  function pushEventError(value) {
    const text = String(value || '').trim();
    if (text) eventErrors.push(text);
  }

  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object') continue;
      if (typeof event.error === 'string') pushEventError(event.error);
      if (typeof event.error?.message === 'string') pushEventError(event.error.message);
      if (typeof event.message === 'string' && String(event.type || '').trim().toLowerCase() === 'error') {
        pushEventError(event.message);
      }
      if (typeof event.result === 'string' && /error|failed/i.test(String(event.subtype || ''))) {
        pushEventError(event.result);
      }
    } catch {
      rawLines.push(line);
    }
  }

  return {
    stdoutSnippet: rawLines.slice(-8).join('\n').slice(-1200),
    eventErrorSnippet: eventErrors.slice(-4).join('\n').slice(-1200),
  };
}

function collectRuntimeFailureDiagnostics(sessionId, entry) {
  const errPath = path.join(runDir(sessionId), 'error.log');
  const outputPath = path.join(runDir(sessionId), 'output.jsonl');

  let stderrSnippet = '';
  try {
    if (fs.existsSync(errPath)) {
      const content = fs.readFileSync(errPath, 'utf8').trim();
      if (content) stderrSnippet = content.slice(-1200);
    }
  } catch {}

  let stdoutSnippet = '';
  let outputEventError = '';
  try {
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf8');
      const diagnostics = extractRuntimeOutputDiagnostics(content);
      stdoutSnippet = diagnostics.stdoutSnippet || '';
      outputEventError = diagnostics.eventErrorSnippet || '';
    }
  } catch {}

  const primary = pickMostUsefulRuntimeError([
    { source: 'lastError', text: entry?.lastError || '' },
    { source: 'output-event', text: outputEventError },
    { source: 'stderr', text: stderrSnippet },
    { source: 'stdout', text: stdoutSnippet },
  ]);

  return {
    stderrSnippet,
    stdoutSnippet,
    outputEventError,
    primaryRawError: primary.text || null,
    primarySource: primary.source || null,
  };
}

function classifyHttpLikeRuntimeError(text) {
  const condensed = condenseRuntimeError(text);
  if (!condensed) return null;
  if (/(404 page not found|http\s*404|status code[: ]*404|\b404\b.*page not found)/i.test(condensed)) {
    return '404';
  }
  if (/(http\s*400|status code[: ]*400|bad request)/i.test(condensed)) {
    return '400';
  }
  if (/(http\s*401|status code[: ]*401|\b401\b.*unauthorized|\bunauthorized\b)/i.test(condensed)) {
    return '401';
  }
  if (/(http\s*403|status code[: ]*403|\b403\b.*forbidden|\bforbidden\b)/i.test(condensed)) {
    return '403';
  }
  if (/(http\s*404|status code[: ]*404)/i.test(condensed)) {
    return '404';
  }
  if (/(http\s*408|status code[: ]*408|request timeout)/i.test(condensed)) {
    return '408';
  }
  if (/(http\s*409|status code[: ]*409|\b409\b.*conflict)/i.test(condensed)) {
    return '409';
  }
  if (/(http\s*422|status code[: ]*422|unprocessable entity)/i.test(condensed)) {
    return '422';
  }
  if (/(http\s*429|status code[: ]*429|too many requests|rate limit)/i.test(condensed)) {
    return '429';
  }
  if (/(http\s*5\d{2}|status code[: ]*5\d{2}|internal server error|bad gateway|gateway timeout|service unavailable)/i.test(condensed)) {
    return '5xx';
  }
  return null;
}

function formatRuntimeError(agent, raw, context = {}) {
  const normalizedAgent = normalizeAgent(agent);
  const agentLabel = getAgentLabel(normalizedAgent);
  const condensed = condenseRuntimeError(raw);
  const exitInfo = typeof context.exitCode === 'number' ? `（退出码 ${context.exitCode}）` : '';
  if (!condensed) {
    return `${agentLabel} 任务异常结束${exitInfo}，但 CLI 没有返回更多错误信息。`;
  }

  if (isLowSignalRuntimeMessage(condensed)) {
    return appendRuntimeErrorDetail(
      `${agentLabel} 任务异常结束${exitInfo}，但 CLI 只返回了会话恢复提示，没有给出真正的失败原因。`,
      context.stdoutSnippet || context.stderrSnippet || condensed
    );
  }

  const httpLike = classifyHttpLikeRuntimeError(condensed);
  if (httpLike === '404') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求的 API 路径不存在（HTTP 404）。请检查当前 API Base、/v1 前缀或后端路由是否正确。`,
      condensed
    );
  }
  if (httpLike === '400') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求参数不被上游接口接受（HTTP 400）。请检查当前模型名、请求格式或自定义兼容层参数。`,
      condensed
    );
  }
  if (httpLike === '401') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 鉴权失败（HTTP 401）。请检查当前 API Key、登录态或鉴权头是否有效。`,
      condensed
    );
  }
  if (httpLike === '403') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求被服务端拒绝（HTTP 403）。请检查账号权限、模型访问许可或服务端白名单设置。`,
      condensed
    );
  }
  if (httpLike === '408') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求等待超时（HTTP 408）。请稍后重试，或检查当前网络和上游响应速度。`,
      condensed
    );
  }
  if (httpLike === '409') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求与当前服务端状态冲突（HTTP 409）。请检查会话状态或稍后重试。`,
      condensed
    );
  }
  if (httpLike === '422') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求已送达，但上游无法处理（HTTP 422）。请检查模型 ID、消息格式或工具参数是否合法。`,
      condensed
    );
  }
  if (httpLike === '429') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 请求被额度或速率限制拦截（HTTP 429）。请检查账号配额、限流策略或稍后重试。`,
      condensed
    );
  }
  if (httpLike === '5xx') {
    return appendRuntimeErrorDetail(
      `${agentLabel} 上游服务异常（HTTP 5xx）。请检查当前服务端状态，或稍后重试。`,
      condensed
    );
  }

  if (normalizedAgent === 'codex') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Codex CLI。请检查 Codex 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `codex`。';
    }
    if (/unexpected argument|unexpected option|Usage:\s*codex/i.test(raw || '')) {
      return `Codex CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Codex CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential/i.test(condensed)) {
      return 'Codex 鉴权失败。请确认本机 Codex CLI 已完成登录，且当前凭据仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Codex 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Codex 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/sandbox|approval|read-only|bypass-approvals/i.test(condensed)) {
      return `Codex 当前的审批或沙箱设置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `Codex 任务失败${exitInfo}：${condensed}`;
  }

  if (normalizedAgent === 'codebuddy') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 CodeBuddy CLI。请检查当前环境是否能直接运行 `codebuddy` / `cbc`，或在 `.env` 中配置 `CODEBUDDY_PATH`。';
    }
    if (/unknown option|unknown flag|Usage:\s*(codebuddy|cbc)|unexpected argument/i.test(raw || '')) {
      return `CodeBuddy CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'CodeBuddy CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential|token/i.test(condensed)) {
      return 'CodeBuddy 鉴权失败。请确认本机 CodeBuddy CLI 已完成登录，且当前凭据仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'CodeBuddy 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'CodeBuddy 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/permission mode|bypasspermissions|acceptedits|approval|sandbox/i.test(condensed)) {
      return `CodeBuddy 当前的权限配置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `CodeBuddy 任务失败${exitInfo}：${condensed}`;
  }

  if (normalizedAgent === 'opencode') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 OpenCode CLI。请检查 OpenCode 设置里的 CLI 路径，或确认系统 PATH 中可直接运行 `opencode`。';
    }
    if (/unknown option|unknown flag|Usage:\s*opencode|Command not found/i.test(raw || '')) {
      return `OpenCode CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'OpenCode CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential|provider/i.test(condensed)) {
      return 'OpenCode 鉴权失败。请确认本机 OpenCode 已完成提供方登录或 API 配置仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'OpenCode 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'OpenCode 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/approval|permission|sandbox|dangerously-skip-permissions/i.test(condensed)) {
      return `OpenCode 当前的权限配置阻止了这次执行：${firstMeaningfulLine(condensed)}`;
    }
    return `OpenCode 任务失败${exitInfo}：${condensed}`;
  }

  if (normalizedAgent === 'kimi') {
    if (/ENOENT|not found|No such file/i.test(condensed)) {
      return '找不到 Kimi CLI。请检查当前环境是否能直接运行 `kimi`，或在 `.env` 中配置 `KIMI_PATH`。';
    }
    if (/unknown option|unknown flag|Usage:\s*kimi|unexpected argument/i.test(raw || '')) {
      return `Kimi CLI 参数不兼容：${firstMeaningfulLine(condensed)}。建议检查当前 CLI 版本与 cc-web 的参数约定是否匹配。`;
    }
    if (/permission denied|EACCES|EPERM/i.test(condensed)) {
      return 'Kimi CLI 启动失败：当前环境没有足够权限执行该命令或访问目标目录。';
    }
    if (/authentication|unauthorized|forbidden|login|api key|credential|token/i.test(condensed)) {
      return 'Kimi 鉴权失败。请确认本机 Kimi CLI 已完成登录，或当前 API / token 配置仍然有效。';
    }
    if (/rate limit|quota|billing|credits/i.test(condensed)) {
      return 'Kimi 请求被额度或速率限制拦截。请检查账号配额、计费状态或稍后重试。';
    }
    if (/network|timed out|timeout|ECONNRESET|ENOTFOUND|TLS|certificate|fetch failed/i.test(condensed)) {
      return 'Kimi 运行时网络请求失败。请检查当前网络、代理或证书环境后重试。';
    }
    if (/plan mode|approval|permission|yolo/i.test(condensed)) {
      return `Kimi 当前的执行模式阻止了这次任务：${firstMeaningfulLine(condensed)}`;
    }
    return `Kimi 任务失败${exitInfo}：${condensed}`;
  }

  if (/ENOENT|not found|No such file/i.test(condensed)) {
    return '找不到 Claude CLI。请检查当前环境是否能直接运行 `claude`。';
  }
  if (/authentication|unauthorized|forbidden|api key|credential/i.test(condensed)) {
    return 'Claude 鉴权失败。请确认本机 Claude CLI 已完成登录，且凭据仍然有效。';
  }
  return `Claude 任务失败${exitInfo}：${condensed}`;
}

function getImportedSourceUpdatedAt(session, context = {}) {
  const normalized = normalizeSession(session);
  const agent = getSessionAgent(normalized);

  if (agent === 'claude' && normalized.claudeSessionId) {
    const directPath = normalized.importedFrom
      ? path.join(CLAUDE_PROJECTS_DIR, String(normalized.importedFrom), `${sanitizeId(normalized.claudeSessionId)}.jsonl`)
      : null;
    const localPath = directPath && fs.existsSync(directPath)
      ? directPath
      : resolveClaudeSessionLocalMeta(normalized.claudeSessionId)?.filePath;
    return getFileMtimeIso(localPath);
  }

  if (agent === 'codex') {
    return getFileMtimeIso(normalized.importedRolloutPath);
  }

  if (agent === 'opencode' && normalized.opencodeSessionId) {
    const map = context.opencodeUpdatedAtById;
    return pickFirstValidIsoTimestamp(map?.get(normalized.opencodeSessionId));
  }

  return null;
}

function repairImportedSessionUpdatedAt() {
  let opencodeUpdatedAtById = null;
  const getOpencodeUpdatedAtById = () => {
    if (opencodeUpdatedAtById) return opencodeUpdatedAtById;
    opencodeUpdatedAtById = new Map(
      getOpencodeSessionList()
        .filter((item) => item?.sessionId)
        .map((item) => [item.sessionId, item.updatedAt || null])
    );
    return opencodeUpdatedAtById;
  };

  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const session = loadSession(file.slice(0, -5));
        if (!session) continue;
        const needsOpencodeMap = getSessionAgent(session) === 'opencode' && !!session.opencodeSessionId;
        const sourceUpdatedAt = getImportedSourceUpdatedAt(session, {
          opencodeUpdatedAtById: needsOpencodeMap ? getOpencodeUpdatedAtById() : null,
        });
        const nextUpdatedAt = pickFirstValidIsoTimestamp(sourceUpdatedAt, session.updated, session.created);
        if (nextUpdatedAt && nextUpdatedAt !== session.updated) {
          session.updated = nextUpdatedAt;
          saveSession(session);
        }
      } catch {}
    }
  } catch {}
}

function compactStartMessage(agent) {
  if (agent === 'codex') return '正在执行 Codex /compact 压缩上下文，请稍候…';
  if (agent === 'codebuddy') return '正在执行 CodeBuddy /compact 压缩上下文，请稍候…';
  if (agent === 'kimi') return '正在执行 Kimi /compact 压缩上下文，请稍候…';
  if (agent === 'opencode') return '正在执行 OpenCode /compact 压缩上下文，请稍候…';
  return '正在执行 Claude 原生 /compact 压缩上下文，请稍候…';
}

function compactDoneMessage(agent) {
  if (agent === 'codex') return '上下文压缩完成。已执行 Codex /compact，下次继续在同一会话发送即可。';
  if (agent === 'codebuddy') return '上下文压缩完成。已执行 CodeBuddy /compact，下次继续在同一会话发送即可。';
  if (agent === 'kimi') return '上下文压缩完成。已执行 Kimi /compact，下次继续在同一会话发送即可。';
  if (agent === 'opencode') return '上下文压缩完成。已执行 OpenCode /compact，下次继续在同一会话发送即可。';
  return '上下文压缩完成。已按 Claude Code 原生策略执行 /compact，下次继续在同一会话发送即可。';
}

function initStartMessage(agent) {
  return usesAgentsMarkdown(agent)
    ? '正在分析项目并生成 AGENTS.md ...'
    : '正在分析项目并生成 CLAUDE.md ...';
}

function buildAgentInitPrompt(agent, cwd) {
  const normalizedAgent = normalizeAgent(agent);
  const targetFile = usesAgentsMarkdown(normalizedAgent) ? 'AGENTS.md' : 'CLAUDE.md';
  const targetPath = path.join(cwd || process.cwd(), targetFile);
  return [
    `You are running cc-web's /init for a ${getAgentLabel(normalizedAgent)} session.`,
    `Analyze the current workspace and create or update ${targetFile} at the repository root.`,
    `The file path to write is: ${targetPath}`,
    'Requirements:',
    '- Actually write the file; do not stop after summarizing in chat.',
    `- If ${targetFile} already exists, update it in place instead of creating a duplicate.`,
    '- Keep the document concise and practical for future coding agents working in this repo.',
    '- Include the project purpose, key entry points, dev/test commands, important workflows, and repo-specific safety constraints.',
    '- Prefer facts from the actual codebase over README claims when they differ.',
    '- After editing the file, reply with a brief summary of what you wrote.',
  ].join('\n');
}

function compactAutoStartMessage(agent) {
  if (agent === 'codex') return '检测到上下文达到上限，正在按 Codex /compact 自动压缩，然后继续当前任务…';
  if (agent === 'codebuddy') return '检测到上下文达到上限，正在按 CodeBuddy /compact 自动压缩，然后继续当前任务…';
  if (agent === 'kimi') return '检测到上下文达到上限，正在按 Kimi /compact 自动压缩，然后继续当前任务…';
  if (agent === 'opencode') return '检测到上下文达到上限，正在按 OpenCode /compact 自动压缩，然后继续当前任务…';
  return '检测到上下文达到上限，正在按 Claude Code 原版策略自动执行 /compact，然后继续当前任务…';
}

function compactAutoResumeMessage(agent) {
  if (agent === 'codex') return '检测到上一条请求因上下文过大失败，现已按 Codex 压缩计划继续执行。';
  if (agent === 'codebuddy') return '检测到上一条请求因上下文过大失败，现已按 CodeBuddy 压缩计划继续执行。';
  if (agent === 'kimi') return '检测到上一条请求因上下文过大失败，现已按 Kimi 压缩计划继续执行。';
  if (agent === 'opencode') return '检测到上一条请求因上下文过大失败，现已按 OpenCode 压缩计划继续执行。';
  return '检测到上一条请求因上下文过大失败，现已自动按压缩计划继续执行。';
}

function isContextLimitError(agent, raw) {
  const text = String(raw || '');
  if (!text) return false;
  if (agent === 'claude') {
    return /Request too large \(max 20MB\)/i.test(text);
  }
  return /context\s+(window|length)|maximum context length|context limit|token limit|too many tokens|input.*too long|prompt.*too long|request too large|please use\s*\/compact|use\s*\/compact|reduce (the )?(input|prompt|message)|exceed(?:ed|s).*(token|context)/i.test(text);
}

function handleProcessComplete(sessionId, exitCode, signal) {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;
  const durationMs = Math.max(0, Date.now() - (Number(entry.startedAt) || Date.now()));
  if (entry.protocolExitTimer) {
    clearTimeout(entry.protocolExitTimer);
    entry.protocolExitTimer = null;
  }

  const completeTime = new Date().toISOString();
  const wsConnected = !!entry.ws;
  const disconnectGap = entry.wsDisconnectTime
    ? ((new Date(completeTime) - new Date(entry.wsDisconnectTime)) / 1000).toFixed(1) + 's'
    : null;

  const pendingRetry = pendingCompactRetries.get(sessionId) || null;
  let contextLimitExceeded = false;

  const diagnostics = collectRuntimeFailureDiagnostics(sessionId, entry);
  const rawCompletionError = entry.lastError
    ? (diagnostics.primaryRawError || condenseRuntimeError(entry.lastError))
    : (
        ((typeof exitCode === 'number' && exitCode !== 0) || (!!signal && signal !== 'SIGTERM'))
          ? (diagnostics.primaryRawError || null)
          : null
      );
  contextLimitExceeded = isContextLimitError(
    entry.agent || 'claude',
    `${entry.fullText || ''}\n${diagnostics.stderrSnippet || ''}\n${diagnostics.stdoutSnippet || ''}\n${rawCompletionError || ''}`
  );
  const completionError = rawCompletionError
    ? formatRuntimeError(entry.agent || 'claude', rawCompletionError, {
        exitCode,
        signal,
        stderrSnippet: diagnostics.stderrSnippet,
        stdoutSnippet: diagnostics.stdoutSnippet,
        errorSource: diagnostics.primarySource,
      })
    : null;
  if (!entry.lastError && rawCompletionError) entry.lastError = rawCompletionError;

  plog(exitCode === 0 || exitCode === null ? 'INFO' : 'WARN', 'process_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
    exitCode,
    signal,
    wsConnected,
    wsDisconnectTime: entry.wsDisconnectTime || null,
    disconnectToDeathGap: disconnectGap,
    responseLen: (entry.fullText || '').length,
    toolCallCount: (entry.toolCalls || []).length,
    cost: entry.lastCost,
    usage: entry.lastUsage || null,
    error: rawCompletionError,
    errorSource: diagnostics.primarySource || null,
    stderr: diagnostics.stderrSnippet || null,
    stdout: diagnostics.stdoutSnippet || null,
    parsedOutputError: diagnostics.outputEventError || null,
    requestTooLarge: contextLimitExceeded,
  });

  // Final read
  if (entry.tailer) {
    entry.tailer.readNew();
    entry.tailer.stop();
  }

  const pendingSlash = pendingSlashCommands.get(sessionId) || null;
  if (pendingSlash) pendingSlashCommands.delete(sessionId);

  // Save result to session
  const session = loadSession(sessionId);
  let hydratedModelChanged = false;
  if (session && getSessionAgent(session) === 'opencode' && session.opencodeSessionId) {
    const latestTurn = getLatestOpencodeAssistantTurn(session.opencodeSessionId);
    if (latestTurn) {
      const shouldHydrate = !entry.fullText
        || (String(latestTurn.content || '').length > String(entry.fullText || '').length)
        || ((latestTurn.toolCalls || []).length > (entry.toolCalls || []).length);
      if (shouldHydrate) {
        entry.fullText = latestTurn.content || '';
        entry.toolCalls = latestTurn.toolCalls || [];
        entry.assistantSteps = latestTurn.steps || [];
      }
      if (latestTurn.totalUsage) {
        session.totalUsage = latestTurn.totalUsage;
        entry.lastUsage = latestTurn.totalUsage;
      }
      if (typeof latestTurn.totalCost === 'number' && Number.isFinite(latestTurn.totalCost)) {
        session.totalCost = latestTurn.totalCost;
      }
      const nextModel = String(latestTurn.model || '').trim();
      if (nextModel && session.model !== nextModel) {
        session.model = nextModel;
        hydratedModelChanged = true;
      }
    }
  }
  if (session && (entry.fullText || (entry.assistantSteps || []).length > 0)) {
    const saved = upsertTrailingAssistantMessage(session, {
      content: entry.fullText,
      toolCalls: entry.toolCalls || [],
      steps: entry.assistantSteps || [],
      timestamp: new Date().toISOString(),
      durationMs,
    });
    if (saved.changed) {
      if (saved.appended) {
        session.updated = new Date().toISOString();
        if (!entry.ws) session.hasUnread = true;
      }
      saveSession(session);
    }
  }

  if (pendingSlash?.kind === 'compact' && session) {
    if (entry.lastCost) {
      session.totalCost = Math.max(0, (session.totalCost || 0) - entry.lastCost);
    }
    session.updated = new Date().toISOString();
    saveSession(session);
  }

  let shouldReturnForFollowup = false;
  let shouldAutoCompact = false;

  activeProcesses.delete(sessionId);
  cleanRunDir(sessionId);
  pendingSlashCommands.delete(sessionId);

  // Notify client
  if (entry.ws) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      const autoRetryRequested = !!(retry?.text && retry?.reason === 'auto');
      if (autoRetryRequested) {
        if (contextLimitExceeded) {
          pendingCompactRetries.delete(sessionId);
          wsSend(entry.ws, { type: 'system_message', message: '已尝试执行 /compact，但仍未成功解除上下文超限。请手动缩小输入范围后重试。' });
        } else {
          wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
          wsSend(entry.ws, { type: 'system_message', message: compactAutoResumeMessage(entry.agent || 'claude') });
          shouldReturnForFollowup = true;
        }
      } else {
        wsSend(entry.ws, { type: 'system_message', message: compactDoneMessage(entry.agent || 'claude') });
      }
    }

    if (contextLimitExceeded && !pendingSlash && session && getRuntimeSessionId(session)) {
      pendingCompactRetries.set(sessionId, { text: pendingRetry?.text || '', mode: pendingRetry?.mode || session.permissionMode || 'yolo', reason: 'auto' });
      wsSend(entry.ws, { type: 'system_message', message: compactAutoStartMessage(entry.agent || 'claude') });
      shouldAutoCompact = true;
    }

    if (completionError && !entry.errorSent && !shouldAutoCompact) {
      entry.errorSent = true;
      wsSend(entry.ws, { type: 'error', message: completionError });
    }

    if (hydratedModelChanged && session?.model) {
      wsSend(entry.ws, { type: 'model_changed', model: sessionModelLabel(session) });
    }
    wsSend(entry.ws, { type: 'done', sessionId, costUsd: entry.lastCost || null, durationMs });
    sendSessionList(entry.ws);
    // Push notification when trigger='always' (user online but still wants notification)
    (() => {
      const notifyCfg = loadNotifyConfig();
      if (!notifyCfg.provider || notifyCfg.provider === 'off') return;
      if ((notifyCfg.summary?.trigger || 'background') !== 'always') return;
      const sess = loadSession(sessionId);
      buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
        sendNotification(ntitle, content);
      });
    })();
  } else {
    // Process completed while browser was disconnected — notify all connected clients
    const sess = loadSession(sessionId);
    const title = sess?.title || 'Untitled';
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        wsSend(client, {
          type: 'background_done',
          sessionId,
          title,
          costUsd: entry.lastCost || null,
          responseLen: (entry.fullText || '').length,
        });
      }
    }
    // Push notification (background task)
    buildNotifyContent(entry, sess, completionError, contextLimitExceeded).then(({ title: ntitle, content }) => {
      sendNotification(ntitle, content);
    });
  }

  if (!shouldReturnForFollowup && !shouldAutoCompact && !contextLimitExceeded && pendingRetry && pendingRetry.text === (entry.fullText || '').trim()) {
    pendingCompactRetries.delete(sessionId);
  }

  if (shouldReturnForFollowup && entry.ws && entry.ws.readyState === 1 && session) {
    if (pendingSlash?.kind === 'compact') {
      const retry = pendingCompactRetries.get(sessionId);
      if (retry?.text) {
        pendingCompactRetries.delete(sessionId);
        handleMessage(entry.ws, { text: retry.text, sessionId, mode: retry.mode || session.permissionMode || 'yolo' });
      }
      return;
    }
  }

  if (shouldAutoCompact && entry.ws && entry.ws.readyState === 1 && session) {
    pendingSlashCommands.set(sessionId, { kind: 'compact' });
    wsSend(entry.ws, { type: 'generation_state', state: 'compacting', sessionId, startedAt: Date.now() });
    handleMessage(entry.ws, { text: '/compact', sessionId, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
    return;
  }
}

function scheduleProtocolProcessExit(sessionId, entry) {
  if (!entry?.protocolComplete || entry.protocolExitScheduled || !entry.pid) return;
  entry.protocolExitScheduled = true;
  plog('INFO', 'runtime_protocol_complete', {
    sessionId: sessionId.slice(0, 8),
    pid: entry.pid,
    agent: entry.agent || 'claude',
  });
  entry.protocolExitTimer = setTimeout(() => {
    entry.protocolExitTimer = null;
    const current = activeProcesses.get(sessionId);
    if (current !== entry || !current.protocolComplete || current.childExited) return;
    if (!getLiveProcessStatus(current).alive) return;
    killProcess(current.pid, IS_WIN);
    if (!IS_WIN) {
      setTimeout(() => {
        const pending = activeProcesses.get(sessionId);
        if (pending === entry && !pending.childExited) killProcess(pending.pid, true);
      }, 1000);
    }
  }, 100);
}

// Global PID monitor: detect process completion (especially after server restart)
setInterval(() => {
  for (const [sessionId, entry] of activeProcesses) {
    const status = getLiveProcessStatus(entry);
    if (entry.pid && !status.alive) {
      plog('INFO', 'pid_monitor_detected_exit', {
        sessionId: sessionId.slice(0, 8),
        pid: entry.pid,
        wsConnected: !!entry.ws,
        reason: status.reason,
      });
      handleProcessComplete(sessionId, null, 'unknown (detected by monitor)');
    }
  }
}, 2000);

cleanupExpiredAttachments();
setInterval(cleanupExpiredAttachments, 6 * 60 * 60 * 1000);

// Recover processes that were running before server restart
function recoverProcesses() {
  try {
    const entries = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('-run') && fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory());
    if (entries.length === 0) return;
    plog('INFO', 'recovery_start', { runDirs: entries.length });
    for (const dirName of entries) {
      const sessionId = dirName.replace('-run', '');
      const dir = path.join(SESSIONS_DIR, dirName);
      const outputPath = path.join(dir, 'output.jsonl');
      const session = loadSession(sessionId);
      if (!session) {
        cleanRunDir(sessionId);
        continue;
      }
      const agent = getSessionAgent(session);
      const runtimeId = getRuntimeSessionId(session);
      const processMeta = readRunProcessMeta(dir);

      if (!processMeta) {
        cleanRunDir(sessionId);
        continue;
      }

      const pid = processMeta.pid;
      const trackedEntry = {
        pid,
        agent,
        runtimeId: processMeta.runtimeId || runtimeId || null,
        processStartMarker: processMeta.processStartMarker,
      };
      const status = getTrackedProcessStatus(trackedEntry);

      if (status.alive) {
        console.log(`[recovery] Re-attaching to session ${sessionId} (PID ${pid})`);
        plog('INFO', 'recovery_alive', {
          sessionId: sessionId.slice(0, 8),
          pid,
          agent,
          reason: status.reason,
          runtimeId: trackedEntry.runtimeId,
        });
        const entry = {
          pid,
          ws: null,
          agent,
          runtimeId: trackedEntry.runtimeId,
          processStartMarker: trackedEntry.processStartMarker,
          startedAt: processMeta.startedAt,
          identityCheck: true,
          fullText: '',
          toolCalls: [],
          assistantSteps: [],
          lastCost: null,
          lastUsage: null,
          lastError: null,
          errorSent: false,
          tailer: null,
        };
        activeProcesses.set(sessionId, entry);

        if (fs.existsSync(outputPath)) {
          entry.tailer = new FileTailer(outputPath, (line) => {
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(entry, event, sessionId);
              scheduleProtocolProcessExit(sessionId, entry);
            } catch {}
          });
          entry.tailer.start();
        }
      } else {
        // Process finished while server was down — read all output and save
        console.log(`[recovery] Processing completed output for session ${sessionId}`);
        plog('INFO', 'recovery_dead', {
          sessionId: sessionId.slice(0, 8),
          pid,
          agent,
          reason: status.reason,
          runtimeId: trackedEntry.runtimeId,
        });
        if (fs.existsSync(outputPath)) {
          const tempEntry = { pid: 0, ws: null, agent, fullText: '', toolCalls: [], assistantSteps: [], lastCost: null, lastUsage: null, lastError: null, errorSent: false, tailer: null };
          const content = fs.readFileSync(outputPath, 'utf8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              processRuntimeEvent(tempEntry, event, sessionId);
            } catch {}
          }
          if (session && (tempEntry.fullText || (tempEntry.assistantSteps || []).length > 0)) {
            const saved = upsertTrailingAssistantMessage(session, {
              content: tempEntry.fullText,
              toolCalls: tempEntry.toolCalls || [],
              steps: tempEntry.assistantSteps || [],
              timestamp: new Date().toISOString(),
            });
            if (saved.changed) {
              if (saved.appended) session.updated = new Date().toISOString();
              saveSession(session);
            }
          }
        }
        cleanRunDir(sessionId);
      }
    }
  } catch (err) {
    console.error('[recovery] Error:', err.message);
  }
}

// === HTTP Static File Server ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/agents.js') {
    const payload = `window.CC_AGENT_CATALOG = ${JSON.stringify(getPublicAgentCatalog(), null, 2)};\n`;
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    return res.end(payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const token = extractBearerToken(req);
    if (!token || !activeTokens.has(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rawName = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    const filename = safeFilename(rawName);
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return jsonResponse(res, 400, { ok: false, message: '仅支持 PNG/JPG/WEBP/GIF 图片' });
    }

    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ATTACHMENT_SIZE) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) {
        return jsonResponse(res, 413, { ok: false, message: '图片大小不能超过 10MB' });
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return jsonResponse(res, 400, { ok: false, message: '图片内容为空' });
      }
      const id = crypto.randomUUID();
      const ext = extFromMime(mime) || path.extname(filename) || '';
      const dataPath = attachmentDataPath(id, ext);
      const now = new Date();
      const meta = {
        id,
        kind: 'image',
        filename,
        mime,
        size: buffer.length,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ATTACHMENT_TTL_MS).toISOString(),
        path: dataPath,
      };
      try {
        fs.writeFileSync(dataPath, buffer);
        saveAttachmentMeta(meta);
        return jsonResponse(res, 200, {
          ok: true,
          attachment: {
            id,
            kind: 'image',
            filename,
            mime,
            size: buffer.length,
            createdAt: meta.createdAt,
            expiresAt: meta.expiresAt,
            storageState: 'available',
          },
        });
      } catch (err) {
        try { if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath); } catch {}
        try { if (fs.existsSync(attachmentMetaPath(id))) fs.unlinkSync(attachmentMetaPath(id)); } catch {}
        return jsonResponse(res, 500, { ok: false, message: `保存附件失败: ${err.message}` });
      }
    });
    req.on('error', () => {
      if (!res.headersSent) jsonResponse(res, 500, { ok: false, message: '上传过程中断' });
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/attachments/')) {
    const token = extractBearerToken(req);
    if (!token || !activeTokens.has(token)) {
      return jsonResponse(res, 401, { ok: false, message: 'Not authenticated' });
    }
    const id = sanitizeId(url.pathname.split('/').pop() || '');
    if (!id) {
      return jsonResponse(res, 400, { ok: false, message: '缺少附件 ID' });
    }
    removeAttachmentById(id);
    return jsonResponse(res, 200, { ok: true });
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  filePath = path.resolve(filePath);

  if (!isPathInside(PUBLIC_DIR, filePath)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// === WebSocket Server ===
const wss = new WebSocketServer({ server });
const historyLoadStates = new WeakMap();

let startupErrorHandled = false;
function handleStartupError(error, source = 'server') {
  const err = error instanceof Error ? error : new Error(String(error || '未知启动错误'));
  plog('ERROR', 'server_start_failed', {
    source,
    code: err.code || null,
    message: err.message || String(err),
    host: HOST,
    port: PORT,
  });

  if (!startupErrorHandled) {
    startupErrorHandled = true;
    if (err.code === 'EADDRINUSE') {
      console.error(`[ERROR] 端口被占用：${HOST}:${PORT}`);
      console.error('已有进程正在监听这个端口。请关闭现有进程，或在 .env 中修改 PORT 后重试。');
    } else {
      console.error(`[ERROR] CC-Web 启动失败：${err.message || String(err)}`);
    }
  }

  setTimeout(() => process.exit(1), 10);
}

server.on('error', (error) => {
  handleStartupError(error, 'http');
});

wss.on('error', (error) => {
  handleStartupError(error, 'websocket');
});

wss.on('connection', (ws, req) => {
  ws._req = req;
  const clientIP = getClientIP(ws);

  // Check if IP is banned
  if (clientIP && isBanned(clientIP)) {
    plog('WARN', 'banned_ip_rejected', { ip: clientIP });
    wsSend(ws, { type: 'auth_result', success: false, banned: true });
    ws.close();
    return;
  }

  let authenticated = false;
  let authToken = null;
  const wsId = crypto.randomBytes(4).toString('hex'); // short id for log correlation
  const wsConnectTime = new Date().toISOString();
  plog('INFO', 'ws_connect', { wsId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return wsSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      // Check ban before processing auth
      if (clientIP && isBanned(clientIP)) {
        wsSend(ws, { type: 'auth_result', success: false, banned: true });
        ws.close();
        return;
      }
      if ((msg.password && verifyPassword(msg.password, authConfig)) || (msg.token && activeTokens.has(msg.token))) {
        authToken = msg.token && activeTokens.has(msg.token) ? msg.token : crypto.randomBytes(32).toString('hex');
        activeTokens.add(authToken);
        authenticated = true;
        wsSend(ws, { type: 'auth_result', success: true, token: authToken, mustChangePassword: !!authConfig.mustChange });
        sendSessionList(ws);
      } else {
        const justBanned = recordAuthFailure(clientIP);
        wsSend(ws, { type: 'auth_result', success: false, banned: justBanned });
        if (justBanned) ws.close();
      }
      return;
    }

    if (!authenticated) {
      return wsSend(ws, { type: 'error', message: 'Not authenticated' });
    }

    switch (msg.type) {
      case 'message':
        if (msg.text && msg.text.trim().startsWith('/')) {
          handleSlashCommand(ws, msg.text.trim(), msg.sessionId, msg.agent);
        } else {
          handleMessage(ws, msg);
        }
        break;
      case 'abort':
        handleAbort(ws);
        break;
      case 'new_session':
        handleNewSession(ws, msg);
        break;
      case 'load_session':
        handleLoadSession(ws, msg.sessionId);
        break;
      case 'load_session_history':
        handleLoadSessionHistory(ws, msg.sessionId);
        break;
      case 'delete_session':
        handleDeleteSession(ws, msg.sessionId);
        break;
      case 'rename_session':
        handleRenameSession(ws, msg.sessionId, msg.title);
        break;
      case 'set_mode':
        handleSetMode(ws, msg.sessionId, msg.mode);
        break;
      case 'list_sessions':
        sendSessionList(ws);
        break;
      case 'get_git_status':
        handleGitStatus(ws, msg.sessionId);
        break;
      case 'get_git_history':
        handleGitHistory(ws, msg);
        break;
      case 'list_workspace_files':
        handleListWorkspaceFiles(ws, msg.sessionId, msg.path);
        break;
      case 'read_workspace_file':
        handleReadWorkspaceFile(ws, msg.sessionId, msg.path);
        break;
      case 'read_workspace_diff':
        handleWorkspaceDiff(ws, msg);
        break;
      case 'detach_view':
        handleDetachView(ws);
        break;
      case 'get_notify_config':
        wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
        break;
      case 'save_notify_config':
        handleSaveNotifyConfig(ws, msg.config);
        break;
      case 'test_notify':
        handleTestNotify(ws);
        break;
      case 'change_password':
        handleChangePassword(ws, msg, authToken);
        break;
      case 'get_model_config':
        wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
        break;
      case 'save_model_config':
        handleSaveModelConfig(ws, msg.config);
        break;
      case 'get_codex_config':
        wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
        break;
      case 'save_codex_config':
        handleSaveCodexConfig(ws, msg.config);
        break;
      case 'get_codebuddy_config':
        wsSend(ws, { type: 'codebuddy_config', config: getCodebuddyConfigMasked() });
        break;
      case 'save_codebuddy_config':
        handleSaveCodebuddyConfig(ws, msg.config);
        break;
      case 'get_kimi_config':
        wsSend(ws, { type: 'kimi_config', config: getKimiConfigMasked() });
        break;
      case 'get_cli_install_status':
        wsSend(ws, { type: 'cli_install_status', status: getCliInstallStatus() });
        break;
      case 'save_kimi_config':
        handleSaveKimiConfig(ws, msg.config);
        break;
      case 'list_agent_models':
        handleListAgentModels(ws, msg);
        break;
      case 'fetch_models':
        handleFetchModels(ws, msg);
        break;
      case 'check_update':
        handleCheckUpdate(ws);
        break;
      case 'read_claude_local_config':
        handleReadClaudeLocalConfig(ws);
        break;
      case 'read_codex_local_config':
        handleReadCodexLocalConfig(ws);
        break;
      case 'read_kimi_local_config':
        handleReadKimiLocalConfig(ws);
        break;
      case 'save_local_snapshot':
        handleSaveLocalSnapshot(ws, msg);
        break;
      case 'restore_claude_local_snapshot':
        handleRestoreClaudeLocalSnapshot(ws);
        break;
      case 'get_dev_config':
        wsSend(ws, { type: 'dev_config', config: getDevConfigMasked() });
        break;
      case 'save_dev_config':
        handleSaveDevConfig(ws, msg);
        break;
      case 'list_agent_import_sessions':
        handleListAgentImportSessions(ws, msg);
        break;
      case 'import_agent_session':
        handleImportAgentSession(ws, msg);
        break;
      case 'list_native_sessions':
        handleListNativeSessions(ws);
        break;
      case 'import_native_session':
        handleImportNativeSession(ws, msg);
        break;
      case 'list_codex_sessions':
        handleListCodexSessions(ws);
        break;
      case 'import_codex_session':
        handleImportCodexSession(ws, msg);
        break;
      case 'list_cwd_suggestions':
        handleListCwdSuggestions(ws, msg);
        break;
      case 'browse_directories':
        handleBrowseDirectories(ws, msg);
        break;
      default:
        wsSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  ws.on('close', () => handleDisconnect(ws, wsId));
  ws.on('error', (err) => {
    plog('WARN', 'ws_error', { wsId, error: err.message });
    handleDisconnect(ws, wsId);
  });
});

// === Notify Config Handlers ===
function handleSaveNotifyConfig(ws, newConfig) {
  if (!newConfig || !newConfig.provider) {
    return wsSend(ws, { type: 'error', message: '无效的通知配置' });
  }
  const current = loadNotifyConfig();
  // Merge: only update fields that are not masked (contain ****)
  const merged = { provider: newConfig.provider };
  // pushplus
  merged.pushplus = { token: (newConfig.pushplus?.token && !newConfig.pushplus.token.includes('****')) ? newConfig.pushplus.token : current.pushplus?.token || '' };
  // telegram
  merged.telegram = {
    botToken: (newConfig.telegram?.botToken && !newConfig.telegram.botToken.includes('****')) ? newConfig.telegram.botToken : current.telegram?.botToken || '',
    chatId: newConfig.telegram?.chatId !== undefined ? newConfig.telegram.chatId : current.telegram?.chatId || '',
  };
  // serverchan
  merged.serverchan = { sendKey: (newConfig.serverchan?.sendKey && !newConfig.serverchan.sendKey.includes('****')) ? newConfig.serverchan.sendKey : current.serverchan?.sendKey || '' };
  // feishu
  merged.feishu = { webhook: (newConfig.feishu?.webhook && !newConfig.feishu.webhook.includes('****')) ? newConfig.feishu.webhook : current.feishu?.webhook || '' };
  // qqbot
  merged.qqbot = { qmsgKey: (newConfig.qqbot?.qmsgKey && !newConfig.qqbot.qmsgKey.includes('****')) ? newConfig.qqbot.qmsgKey : current.qqbot?.qmsgKey || '' };
  // summary
  const ns = newConfig.summary || {};
  const cs = current.summary || {};
  merged.summary = {
    enabled: !!ns.enabled,
    trigger: ['background', 'always'].includes(ns.trigger) ? ns.trigger : (cs.trigger || 'background'),
    apiSource: ['claude', 'codex', 'custom'].includes(ns.apiSource) ? ns.apiSource : (cs.apiSource || 'claude'),
    apiBase: ns.apiBase !== undefined ? ns.apiBase : (cs.apiBase || ''),
    apiKey: (ns.apiKey && !ns.apiKey.includes('****')) ? ns.apiKey : (cs.apiKey || ''),
    model: ns.model !== undefined ? ns.model : (cs.model || ''),
  };

  saveNotifyConfig(merged);
  plog('INFO', 'notify_config_saved', { provider: merged.provider });
  wsSend(ws, { type: 'notify_config', config: getNotifyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '通知配置已保存' });
}

function handleTestNotify(ws) {
  const config = loadNotifyConfig();
  if (!config.provider || config.provider === 'off') {
    return wsSend(ws, { type: 'notify_test_result', success: false, message: '通知已关闭，无法测试' });
  }
  sendNotification('CC-Web 测试通知', '这是一条测试消息，如果你收到了说明通知配置正确！').then((result) => {
    wsSend(ws, { type: 'notify_test_result', success: result.ok, message: result.ok ? '测试消息已发送，请检查是否收到' : `发送失败: ${result.error || result.body || '未知错误'}` });
  });
}

function handleChangePassword(ws, msg, currentToken) {
  const { currentPassword, newPassword } = msg;

  // Validate current password
  if (!verifyPassword(currentPassword, authConfig)) {
    return wsSend(ws, { type: 'password_changed', success: false, message: '当前密码错误' });
  }

  // Validate new password strength
  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    return wsSend(ws, { type: 'password_changed', success: false, message: strength.message });
  }

  // Save new password
  authConfig = buildHashedAuthConfig(newPassword, false);
  saveAuthConfig(authConfig);
  plog('INFO', 'password_changed', {});

  // Clear all tokens (force all sessions to re-login)
  activeTokens.clear();

  // Generate new token for current connection
  const newToken = crypto.randomBytes(32).toString('hex');
  activeTokens.add(newToken);

  wsSend(ws, { type: 'password_changed', success: true, token: newToken, message: '密码修改成功' });
}

// === Model Config Handler ===
function handleSaveModelConfig(ws, newConfig) {
  if (!newConfig || !['local', 'custom'].includes(newConfig.mode)) {
    return wsSend(ws, { type: 'error', message: '无效的模型配置' });
  }
  const current = loadModelConfig();
  const merged = {
    mode: newConfig.mode,
    activeTemplate: newConfig.activeTemplate || '',
    templates: [],
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };

  // Merge templates: keep existing secrets if masked
  const newTemplates = Array.isArray(newConfig.templates) ? newConfig.templates : [];
  const oldTemplates = Array.isArray(current.templates) ? current.templates : [];
  for (const nt of newTemplates) {
    if (!nt.name || !nt.name.trim()) continue;
    const old = oldTemplates.find(t => t.name === nt.name);
    merged.templates.push({
      name: nt.name.trim(),
      apiKey: (nt.apiKey && !nt.apiKey.includes('****')) ? nt.apiKey : (old?.apiKey || ''),
      apiBase: nt.apiBase || '',
      defaultModel: nt.defaultModel || '',
      opusModel: nt.opusModel || '',
      sonnetModel: nt.sonnetModel || '',
      haikuModel: nt.haikuModel || '',
    });
  }

  saveModelConfig(merged);

  // Re-apply at runtime (mutate in-place to preserve agent-runtime closure reference)
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  // custom mode: write to ~/.claude/settings.json immediately on save
  if (merged.mode === 'custom' && merged.activeTemplate) {
    const tpl = merged.templates.find(t => t.name === merged.activeTemplate);
    if (tpl) applyCustomTemplateToSettings(tpl);
  }

  // Remap ALL Claude sessions' model to current runtime MODEL_MAP values.
  // Build reverse map from BOTH pre-save and post-save template model names:
  // - current.templates: identifies sessions created under old model names (including edited/renamed)
  // - merged.templates: keeps post-save model names in the lookup as well
  // Include both raw and [1m]-suffixed keys: applyModelConfig() appends [1m] to
  // opus/sonnet when storing into session.model, so we need both forms to match.
  const modelToTier = new Map();
  const lookupTemplates = [
    ...(Array.isArray(current.templates) ? current.templates : []),
    ...(Array.isArray(merged.templates) ? merged.templates : []),
  ];
  for (const tpl of lookupTemplates) {
    if (tpl.opusModel) {
      modelToTier.set(tpl.opusModel, 'opus');
      if (!tpl.opusModel.endsWith('[1m]')) modelToTier.set(tpl.opusModel + '[1m]', 'opus');
    }
    if (tpl.sonnetModel) {
      modelToTier.set(tpl.sonnetModel, 'sonnet');
      if (!tpl.sonnetModel.endsWith('[1m]')) modelToTier.set(tpl.sonnetModel + '[1m]', 'sonnet');
    }
    if (tpl.haikuModel) modelToTier.set(tpl.haikuModel, 'haiku');
  }
  try {
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      try {
        const session = loadSession(sessionId);
        if (!session?.model || getSessionAgent(session) !== 'claude') continue;
        const tier = modelToTier.get(session.model);
        if (tier && MODEL_MAP[tier] !== session.model) {
          session.model = MODEL_MAP[tier];
          session.updated = new Date().toISOString();
          saveSession(session);
        }
      } catch {}
    }
  } catch {}

  plog('INFO', 'model_config_saved', { mode: merged.mode, activeTemplate: merged.activeTemplate });
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '模型配置已保存' });
}

function handleSaveCodexConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Codex 配置' });
  }
  const current = loadCodexConfig();
  const newProfiles = Array.isArray(newConfig.profiles) ? newConfig.profiles : [];
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const profile of newProfiles) {
    const name = String(profile?.name || '').trim();
    if (!name) continue;
    const old = oldProfiles.find((item) => item.name === name);
    const rawApiKey = String(profile?.apiKey || '');
    mergedProfiles.push({
      name,
      apiKey: rawApiKey && !rawApiKey.includes('****') ? rawApiKey : (old?.apiKey || ''),
      apiBase: String(profile?.apiBase || '').trim(),
    });
  }
  const requestedSearch = !!newConfig.enableSearch;
  const merged = {
    mode: newConfig.mode === 'custom' ? 'custom' : 'local',
    activeProfile: String(newConfig.activeProfile || '').trim(),
    profiles: mergedProfiles,
    enableSearch: false,
    supportsSearch: false,
    storedEnableSearch: requestedSearch,
    localSnapshot: newConfig.localSnapshot || current.localSnapshot || {},
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }
  saveCodexConfig(merged);
  plog('INFO', 'codex_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
    enableSearchRequested: requestedSearch,
    enableSearchEffective: false,
  });
  wsSend(ws, { type: 'codex_config', config: getCodexConfigMasked() });
  wsSend(ws, {
    type: 'system_message',
    message: requestedSearch
      ? 'Codex 配置已保存。当前 cc-web 的 Codex exec 路径暂未接入 Web Search，已自动忽略该开关。'
      : 'Codex 配置已保存',
  });
}

function mergeMaskedSecret(nextValue, currentValue) {
  const raw = String(nextValue || '');
  if (!raw) return '';
  return raw.includes('****') ? String(currentValue || '') : raw;
}

function resolveActiveCodebuddyProfile(config) {
  if (!config || config.mode !== 'custom') return null;
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  return profiles.find((profile) => profile.name === config.activeProfile) || null;
}

function buildCodebuddyEnvFromProfile(profile) {
  const env = {};
  if (!profile) return env;
  if (profile.authToken) env.CODEBUDDY_AUTH_TOKEN = profile.authToken;
  if (profile.apiKey) env.CODEBUDDY_API_KEY = profile.apiKey;
  return env;
}

function handleSaveCodebuddyConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 CodeBuddy 配置' });
  }

  const current = loadCodebuddyConfig();
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const rawProfile of Array.isArray(newConfig.profiles) ? newConfig.profiles : []) {
    const sanitized = sanitizeCodebuddyProfile(rawProfile);
    if (!sanitized.name) continue;
    const originalName = String(rawProfile?._originalName || rawProfile?.name || '').trim();
    const oldProfile = oldProfiles.find((profile) => profile.name === originalName || profile.name === sanitized.name) || null;
    sanitized.authToken = mergeMaskedSecret(rawProfile?.authToken, oldProfile?.authToken);
    sanitized.apiKey = mergeMaskedSecret(rawProfile?.apiKey, oldProfile?.apiKey);
    mergedProfiles.push(sanitized);
  }

  const merged = {
    mode: newConfig.mode === 'custom' ? 'custom' : 'local',
    activeProfile: String(newConfig.activeProfile || '').trim(),
    profiles: mergedProfiles,
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }

  saveCodebuddyConfig(merged);
  plog('INFO', 'codebuddy_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
  });
  wsSend(ws, { type: 'codebuddy_config', config: getCodebuddyConfigMasked() });
  wsSend(ws, { type: 'system_message', message: 'CodeBuddy 配置已保存' });
}

function handleSaveKimiConfig(ws, newConfig) {
  if (!newConfig || typeof newConfig !== 'object') {
    return wsSend(ws, { type: 'error', message: '无效的 Kimi 配置' });
  }

  const current = loadKimiConfig();
  const oldProfiles = Array.isArray(current.profiles) ? current.profiles : [];
  const mergedProfiles = [];
  for (const rawProfile of Array.isArray(newConfig.profiles) ? newConfig.profiles : []) {
    const sanitized = sanitizeKimiProfile(rawProfile);
    if (!sanitized.name) continue;
    const originalName = String(rawProfile?._originalName || rawProfile?.name || '').trim();
    const oldProfile = oldProfiles.find((profile) => profile.name === originalName || profile.name === sanitized.name) || null;
    sanitized.apiKey = mergeMaskedSecret(rawProfile?.apiKey, oldProfile?.apiKey);
    sanitized.services.searchApiKey = mergeMaskedSecret(rawProfile?.services?.searchApiKey, oldProfile?.services?.searchApiKey);
    sanitized.services.fetchApiKey = mergeMaskedSecret(rawProfile?.services?.fetchApiKey, oldProfile?.services?.fetchApiKey);
    mergedProfiles.push(sanitized);
  }

  const merged = {
    mode: newConfig.mode === 'custom' ? 'custom' : 'local',
    activeProfile: String(newConfig.activeProfile || '').trim(),
    profiles: mergedProfiles,
  };
  if (merged.mode === 'custom' && merged.profiles.length > 0 && !merged.profiles.some((profile) => profile.name === merged.activeProfile)) {
    merged.activeProfile = merged.profiles[0].name;
  }

  saveKimiConfig(merged);
  plog('INFO', 'kimi_config_saved', {
    mode: merged.mode,
    activeProfile: merged.activeProfile || null,
    profileCount: merged.profiles.length,
  });
  wsSend(ws, { type: 'kimi_config', config: getKimiConfigMasked() });
  wsSend(ws, { type: 'system_message', message: 'Kimi 配置已保存' });
}

// === Local Config Snapshot Handlers ===
function handleReadClaudeLocalConfig(ws) {
  let settings = {};
  let sourceFound = false;
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
      sourceFound = true;
    }
  } catch {}
  const env = settings.env || {};
  const config = {
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '',
    apiBase: env.ANTHROPIC_BASE_URL || '',
    defaultModel: env.ANTHROPIC_MODEL || '',
    opusModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
    sonnetModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
    haikuModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
  };
  wsSend(ws, { type: 'claude_local_config', config, sourceFound });
}

function handleReadCodexLocalConfig(ws) {
  let config = { apiKey: '', apiBase: '' };
  let sourceFound = false;
  let hasApiKey = false;

  // Read ~/.codex/config.toml for api_base
  const codexConfigToml = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'config.toml');
  try {
    if (fs.existsSync(codexConfigToml)) {
      sourceFound = true;
      const toml = fs.readFileSync(codexConfigToml, 'utf8');
      const baseMatch = toml.match(/base_url\s*=\s*"([^"]+)"/);
      if (baseMatch) config.apiBase = baseMatch[1];
    }
  } catch {}

  // Read ~/.codex/auth.json for api_key
  const codexAuthJson = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'auth.json');
  try {
    if (fs.existsSync(codexAuthJson)) {
      const auth = JSON.parse(fs.readFileSync(codexAuthJson, 'utf8'));
      if (auth.OPENAI_API_KEY) {
        config.apiKey = auth.OPENAI_API_KEY;
        hasApiKey = true;
      }
    }
  } catch {}

  const result = { type: 'codex_local_config', config, sourceFound, hasApiKey };
  if (!hasApiKey) result.warning = '本机使用登录态认证，未检测到 API Key';
  wsSend(ws, result);
}

function handleReadKimiLocalConfig(ws) {
  const config = readKimiLocalConfigFile();
  wsSend(ws, {
    type: 'kimi_local_config',
    config: {
      sourcePath: config.sourcePath || '',
      defaultModel: config.defaultModel || '',
      models: Array.isArray(config.models) ? [...config.models] : [],
      providerName: config.providerName || '',
      providerType: config.providerType || '',
      apiKey: config.apiKey || '',
      apiBase: config.apiBase || '',
      modelName: config.modelName || '',
      maxContextSize: config.maxContextSize || '',
      capabilities: Array.isArray(config.capabilities) ? [...config.capabilities] : [],
      searchBase: config.searchBase || '',
      searchApiKey: config.searchApiKey || '',
      fetchBase: config.fetchBase || '',
      fetchApiKey: config.fetchApiKey || '',
    },
    sourceFound: !!config.sourceFound,
  });
}

function handleSaveLocalSnapshot(ws, msg) {
  const config = loadModelConfig();
  config.localSnapshot = msg.snapshot || {};
  saveModelConfig(config);
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '本地配置快照已保存' });
}

function handleRestoreClaudeLocalSnapshot(ws) {
  const config = loadModelConfig();
  const snapshot = config.localSnapshot;
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return wsSend(ws, { type: 'error', message: '没有已保存的本地配置快照' });
  }
  applyCustomTemplateToSettings(snapshot);
  // Switch to local mode after restore
  config.mode = 'local';
  config.activeTemplate = '';
  saveModelConfig(config);
  // Reset MODEL_MAP to local defaults
  MODEL_MAP.opus = 'claude-opus-4-6';
  MODEL_MAP.sonnet = 'claude-sonnet-4-6';
  MODEL_MAP.haiku = 'claude-haiku-4-5-20251001';
  applyModelConfig();
  wsSend(ws, { type: 'model_config', config: getModelConfigMasked() });
  wsSend(ws, { type: 'system_message', message: '已恢复本地配置快照到 ~/.claude/settings.json' });
}

// === Fetch Upstream Models ===
function handleFetchModels(ws, msg) {
  const { apiBase, apiKey, modelsEndpoint } = msg;
  if (!apiBase || !apiKey) {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '需要填写 API Base 和 API Key' });
  }
  // Build URL: apiBase + modelsEndpoint (default /v1/models)
  let base = apiBase.replace(/\/+$/, '');
  const endpoint = modelsEndpoint || '/v1/models';
  const fullUrl = base + endpoint;

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    return wsSend(ws, { type: 'fetch_models_result', success: false, message: '无效的 URL: ' + fullUrl });
  }

  // Resolve real apiKey (if masked, look up saved config by template name or apiBase)
  let realKey = apiKey;
  if (apiKey.includes('****')) {
    const config = loadModelConfig();
    const saved = (config.templates || []);
    // Match by template name first, then by apiBase
    const tpl = (msg.templateName && saved.find(t => t.name === msg.templateName))
      || saved.find(t => t.apiBase && t.apiBase.replace(/\/+$/, '') === base)
      || null;
    if (tpl && tpl.apiKey && !tpl.apiKey.includes('****')) realKey = tpl.apiKey;
    else return wsSend(ws, { type: 'fetch_models_result', success: false, message: 'API Key 已脱敏，请重新输入完整 Key' });
  }

  const mod = parsed.protocol === 'https:' ? require('https') : require('http');
  const reqOptions = {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${realKey}` },
    timeout: 15000,
  };

  const req = mod.request(parsed, reqOptions, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'fetch_models_result', success: false, message: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
      }
      try {
        const json = JSON.parse(body);
        const models = (json.data || json.models || []).map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean).sort();
        wsSend(ws, { type: 'fetch_models_result', success: true, models });
      } catch (e) {
        wsSend(ws, { type: 'fetch_models_result', success: false, message: '解析响应失败: ' + e.message });
      }
    });
  });

  req.on('error', (e) => {
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'fetch_models_result', success: false, message: '请求超时 (15s)' });
  });
  req.end();
}

function handleListAgentModels(ws, msg) {
  const agent = normalizeAgent(msg?.agent);
  const requestId = String(msg?.requestId || '').trim() || null;

  if (agent === 'codebuddy') {
    listCodebuddyModels()
      .then((result) => {
        wsSend(ws, {
          type: 'agent_models_result',
          agent,
          requestId,
          success: !!result?.success,
          models: result?.models || [],
          message: result?.message || '',
        });
      })
      .catch((error) => {
        wsSend(ws, {
          type: 'agent_models_result',
          agent,
          requestId,
          success: false,
          models: [],
          message: formatRuntimeError('codebuddy', String(error?.message || error || '无法读取模型列表')),
        });
      });
    return;
  }

  if (agent === 'kimi') {
    const result = listKimiModels();
    return wsSend(ws, {
      type: 'agent_models_result',
      agent,
      requestId,
      success: !!result.success,
      models: result.models || [],
      message: result.message || '',
    });
  }

  if (agent === 'opencode') {
    const result = listOpencodeModels();
    return wsSend(ws, {
      type: 'agent_models_result',
      agent,
      requestId,
      success: !!result.success,
      models: result.models || [],
      message: result.message || '',
    });
  }

  wsSend(ws, {
    type: 'agent_models_result',
    agent,
    requestId,
    success: false,
    models: [],
    message: `${getAgentLabel(agent)} 暂不支持读取模型列表`,
  });
}

// === Slash Command Handler ===
function handleSlashCommand(ws, text, sessionId, fallbackAgent) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  let session = sessionId ? loadSession(sessionId) : null;
  const agent = session ? getSessionAgent(session) : normalizeAgent(fallbackAgent);

  switch (cmd) {
    case '/clear': {
      if (session) {
        if (activeProcesses.has(sessionId)) {
          const entry = activeProcesses.get(sessionId);
          killProcess(entry.pid);
          if (entry.tailer) entry.tailer.stop();
          activeProcesses.delete(sessionId);
          cleanRunDir(sessionId);
        }
        session.messages = [];
        clearRuntimeSessionId(session);
        session.totalUsage = {
          ...(session.totalUsage || {}),
          contextTokens: 0,
        };
        session.updated = new Date().toISOString();
        saveSession(session);
        wsSend(ws, {
          type: 'session_info',
          sessionId: session.id,
          messages: [],
          title: session.title,
          mode: session.permissionMode || 'yolo',
          model: sessionModelLabel(session),
          agent: getSessionAgent(session),
          cwd: session.cwd || null,
          totalCost: session.totalCost || 0,
          totalUsage: session.totalUsage || null,
          taskMode: session.taskMode || 'local',
          sshHostId: session.sshHostId || '',
          remoteCwd: session.remoteCwd || '',
        });
      }
      wsSend(ws, { type: 'system_message', message: '会话已清除，上下文已重置。' });
      break;
    }

    case '/model': {
      const modelInput = parts[1];
      if (agent === 'codex' || agent === 'codebuddy' || agent === 'kimi' || agent === 'opencode') {
        const agentLabel = agent === 'codex'
          ? 'Codex'
          : agent === 'codebuddy'
            ? 'CodeBuddy'
            : agent === 'kimi'
              ? 'Kimi'
              : 'OpenCode';
        if (!modelInput) {
          const current = session?.model || '配置默认模型';
          wsSend(ws, { type: 'system_message', message: `当前 ${agentLabel} 模型: ${current}\n用法: /model <模型名>` });
        } else {
          rememberAgentModel(agent, modelInput);
          if (session) {
            session.model = modelInput;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelInput });
          wsSend(ws, { type: 'system_message', message: `${agentLabel} 模型已切换为: ${modelInput}` });
        }
      } else if (!modelInput) {
        const current = session?.model ? modelShortName(session.model) || session.model : 'opus (默认)';
        wsSend(ws, { type: 'system_message', message: `当前模型: ${current}\n可选: opus, sonnet, haiku` });
      } else {
        const modelKey = modelInput.toLowerCase();
        if (!MODEL_MAP[modelKey]) {
          wsSend(ws, { type: 'system_message', message: `无效模型: ${modelInput}\n可选: opus, sonnet, haiku` });
        } else {
          const model = MODEL_MAP[modelKey];
          rememberAgentModel(agent, model);
          if (session) {
            session.model = model;
            session.updated = new Date().toISOString();
            saveSession(session);
          }
          wsSend(ws, { type: 'model_changed', model: modelKey });
          wsSend(ws, { type: 'system_message', message: `模型已切换为: ${modelKey}` });
        }
      }
      break;
    }

    case '/cost': {
      if (agent === 'kimi') {
        wsSend(ws, { type: 'system_message', message: 'Kimi 当前未在 cc-web 中提供会话级 token / 费用统计。' });
      } else if (isUsageMeteredAgent(agent)) {
        const usage = session?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        wsSend(ws, {
          type: 'system_message',
          message: `当前会话累计 Token: 输入 ${usage.inputTokens}，缓存 ${usage.cachedInputTokens}，输出 ${usage.outputTokens}`,
        });
      } else {
        const cost = session?.totalCost || 0;
        wsSend(ws, { type: 'system_message', message: `当前会话累计费用: $${cost.toFixed(4)}` });
      }
      break;
    }

    case '/compact': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '当前没有可压缩的会话。请先进入一个已进行过对话的会话后再执行 /compact。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止，再执行 /compact。' });
        break;
      }
      const runtimeId = getRuntimeSessionId(session);
      if (!runtimeId) {
      wsSend(ws, {
        type: 'system_message',
        message: agent === 'codex'
          ? '当前会话尚未建立 Codex 上下文，暂时无需压缩。'
          : agent === 'codebuddy'
            ? '当前会话尚未建立 CodeBuddy 上下文，暂时无需压缩。'
          : agent === 'kimi'
            ? '当前会话尚未建立 Kimi 上下文，暂时无需压缩。'
          : agent === 'opencode'
            ? '当前会话尚未建立 OpenCode 上下文，暂时无需压缩。'
            : '当前会话尚未建立 Claude 上下文，暂时无需压缩。',
      });
      break;
    }

      wsSend(ws, { type: 'system_message', message: compactStartMessage(agent) });
      wsSend(ws, { type: 'generation_state', state: 'compacting', sessionId: session.id, startedAt: Date.now() });
      pendingSlashCommands.set(session.id, { kind: 'compact' });
      handleMessage(ws, { text: '/compact', sessionId: session.id, mode: session.permissionMode || 'yolo' }, { hideInHistory: true });
      break;
    }

    case '/init': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /init。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      wsSend(ws, { type: 'system_message', message: initStartMessage(agent) });
      pendingSlashCommands.set(session.id, { kind: 'init' });
      handleMessage(ws, {
        text: usesAgentsMarkdown(agent) ? buildAgentInitPrompt(agent, session.cwd) : '/init',
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/github': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /github。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const ghArgs = parts.slice(1).join(' ').trim() || '列出所有可用仓库';
      const ghPrompt = [
        '[系统指令]',
        '用户请求执行 GitHub 相关操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 GitHub token 和仓库信息`,
        '2. 根据用户的自然语言指令匹配对应的仓库（按 name 或 notes 字段）',
        '3. 使用读取到的 token 进行 git 认证（可设置环境变量 GIT_TOKEN 或直接在 URL 中使用）',
        '4. 严格禁止在回复中打印、回显或引用 token 的完整内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${ghArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'github' });
      handleMessage(ws, {
        text: ghPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

    case '/ssh': {
      if (!sessionId || !session) {
        wsSend(ws, { type: 'system_message', message: '请先进入一个会话后再执行 /ssh。' });
        break;
      }
      if (activeProcesses.has(sessionId)) {
        wsSend(ws, { type: 'system_message', message: '当前会话正在处理中，请先等待完成或点击停止。' });
        break;
      }
      const sshArgs = parts.slice(1).join(' ').trim() || '列出所有可用主机';
      const sshPrompt = [
        '[系统指令]',
        '用户请求执行 SSH 远程操作。请按以下步骤执行：',
        `1. 使用 Read 工具读取 ${DEV_CONFIG_PATH} 获取 SSH 主机信息`,
        '2. 根据用户的自然语言指令匹配对应的主机（按 name 或 description 字段）',
        '3. 根据主机的 authType 字段选择认证方式：',
        '   - authType 为 "key" 时：使用 ssh -i {identityFile} -p {port} {user}@{host} 连接',
        '   - authType 为 "password" 时：使用 sshpass -p {password} ssh -p {port} {user}@{host} 连接（如系统无 sshpass 可先安装）',
        '4. 严格禁止在回复中打印任何密钥或密码内容',
        '5. 操作完成后简要报告结果',
        '',
        `用户指令：${sshArgs}`,
      ].join('\n');
      pendingSlashCommands.set(session.id, { kind: 'ssh' });
      handleMessage(ws, {
        text: sshPrompt,
        sessionId: session.id,
        mode: session.permissionMode || 'yolo',
      }, { hideInHistory: true });
      break;
    }

		    case '/mode': {
		      const modeInput = parts[1];
		      const VALID_MODES = ['default', 'plan', 'yolo'];
		      const MODE_DESC = { default: '默认（需权限审批，受限操作）', plan: 'Plan（需确认计划后执行）', yolo: 'YOLO（跳过所有权限检查）' };
		      if (!modeInput) {
		        const cur = session?.permissionMode || 'yolo';
		        wsSend(ws, { type: 'system_message', message: `当前模式: ${MODE_DESC[cur] || cur}\n可选: default, plan, yolo` });
		      } else if (VALID_MODES.includes(modeInput.toLowerCase())) {
		        const mode = modeInput.toLowerCase();
		        if (session) {
		          session.permissionMode = mode;
		          // Mode switching should not reset runtime context (Claude/Codex both resume).
		          session.updated = new Date().toISOString();
		          saveSession(session);
		        }
		        wsSend(ws, { type: 'system_message', message: `权限模式已切换为: ${MODE_DESC[mode]}` });
		        wsSend(ws, { type: 'mode_changed', mode });
		      } else {
	        wsSend(ws, { type: 'system_message', message: `无效模式: ${modeInput}\n可选: default, plan, yolo` });
      }
      break;
    }

    case '/help': {
      const base = '可用指令:\n' +
        '/clear — 清除当前会话（含上下文）\n' +
        '/mode [模式] — 查看/切换权限模式（default, plan, yolo）\n' +
        '/cost — 查看当前会话累计统计\n' +
        '/github [指令] — GitHub 操作（读取开发者配置后执行）\n' +
        '/ssh [指令] — SSH 远程操作（读取开发者配置后执行）\n' +
        '/help — 显示本帮助';
      wsSend(ws, {
        type: 'system_message',
        message: agent === 'codex'
          ? base + '\n/model [名称] — 查看/切换 Codex 模型（自由输入）\n/compact — 执行 Codex /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
          : agent === 'codebuddy'
            ? base + '\n/model [名称] — 查看/切换 CodeBuddy 模型（自由输入）\n/compact — 执行 CodeBuddy /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
          : agent === 'kimi'
            ? base + '\n/model [名称] — 查看/切换 Kimi 模型（自由输入）\n/compact — 执行 Kimi /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
          : agent === 'opencode'
            ? base + '\n/model [名称] — 查看/切换 OpenCode 模型（provider/model）\n/compact — 执行 OpenCode /compact 压缩上下文\n/init — 分析项目并生成/更新 AGENTS.md'
            : base + '\n/model [名称] — 查看/切换模型（opus, sonnet, haiku）\n/compact — 执行 Claude 原生上下文压缩（保留压缩计划并可自动续跑）\n/init — 分析项目并生成/更新 CLAUDE.md',
      });
      break;
    }

    default:
      wsSend(ws, { type: 'system_message', message: `未知指令: ${cmd}\n输入 /help 查看可用指令` });
  }
}

// === Session Handlers ===
function handleNewSession(ws, msg) {
  const cwd = (msg && msg.cwd) ? String(msg.cwd) : null;
  const agent = normalizeAgent(msg?.agent);
  const requestedMode = ['default', 'plan', 'yolo'].includes(msg?.mode) ? msg.mode : 'yolo';
  const taskMode = msg?.taskMode === 'remote' ? 'remote' : 'local';
  const sshHostId = String(msg?.sshHostId || '').trim();
  const remoteCwd = String(msg?.remoteCwd || '').trim();
  const requestedCodebuddyProfile = String(msg?.codebuddyProfile || '').trim();

  let resolvedCwd = cwd || resolveAgentDefaultCwd(agent);
  let hostInfo = null;

  // Remote task: create host-specific directory and inject host info
  if (taskMode === 'remote' && sshHostId) {
    const devConfig = loadDevConfig();
    hostInfo = (devConfig.ssh.hosts || []).find(h => h.id === sshHostId) || null;
    if (hostInfo) {
      const hostDir = path.join(CONFIG_DIR, 'host', sshHostId);
      fs.mkdirSync(hostDir, { recursive: true });
      resolvedCwd = hostDir;
    }
  }

  const id = crypto.randomUUID();
  const runtimeField = getRuntimeSessionField(agent);
  const session = {
    id,
    title: 'New Chat',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    agent,
    [runtimeField]: null,
    model: resolveAgentDefaultSessionModel(agent),
    permissionMode: requestedMode,
    totalCost: 0,
    totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: [],
    cwd: resolvedCwd,
    taskMode,
    sshHostId: taskMode === 'remote' ? sshHostId : '',
    remoteCwd: taskMode === 'remote' ? remoteCwd : '',
    codebuddyProfile: '',
  };
  if (agent === 'codebuddy') {
    const codebuddyConfig = loadCodebuddyConfig();
    const availableProfiles = Array.isArray(codebuddyConfig.profiles) ? codebuddyConfig.profiles : [];
    if (codebuddyConfig.mode === 'custom' && requestedCodebuddyProfile && availableProfiles.some((profile) => profile.name === requestedCodebuddyProfile)) {
      session.codebuddyProfile = requestedCodebuddyProfile;
    } else {
      session.codebuddyProfile = codebuddyConfig.mode === 'custom' ? String(codebuddyConfig.activeProfile || '').trim() : '';
    }
  }
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: [],
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent,
    cwd: session.cwd,
    totalCost: 0,
    totalUsage: session.totalUsage,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode,
    sshHostId: session.sshHostId,
    remoteCwd: session.remoteCwd,
    codebuddyProfile: session.codebuddyProfile || '',
  });
  sendSessionList(ws);

  // Inject initial prompt for remote sessions
  if (taskMode === 'remote' && hostInfo) {
    const authType = hostInfo.authType || 'key';
    const authInfo = authType === 'password'
      ? `密码认证（密码已配置，使用 sshpass 连接）`
      : `密钥认证：${hostInfo.identityFile || '(未配置)'}`;
    const sshCmd = authType === 'password'
      ? `sshpass -p <password> ssh -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`
      : `ssh -i ${hostInfo.identityFile} -p ${hostInfo.port} ${hostInfo.user}@${hostInfo.host}`;
    const initPrompt = [
      '[系统上下文]',
      '当前为远程任务会话。目标主机信息：',
      `- 主机名：${hostInfo.name}`,
      `- 地址：${hostInfo.user}@${hostInfo.host}:${hostInfo.port}`,
      `- 认证方式：${authInfo}`,
      `- 远端工作目录：${remoteCwd || 'SSH 默认目录'}`,
      `本地工作目录为 ${resolvedCwd}。`,
      `连接命令：${sshCmd}`,
      '严格禁止在回复中打印任何密钥或密码内容。',
    ].join('\n');
    handleMessage(ws, {
      text: initPrompt,
      sessionId: id,
      mode: requestedMode,
    }, { hideInHistory: true });
  }
}

function handleLoadSession(ws, sessionId) {
  const session = loadSession(sessionId);
  if (!session) {
    return wsSend(ws, { type: 'error', message: 'Session not found' });
  }
  if (getSessionAgent(session) === 'claude' && !session.cwd && session.claudeSessionId) {
    const localMeta = resolveClaudeSessionLocalMeta(session.claudeSessionId);
    if (localMeta?.cwd) {
      session.cwd = localMeta.cwd;
      if (!session.importedFrom && localMeta.projectDir) session.importedFrom = localMeta.projectDir;
      saveSession(session);
    }
  }
  if (getSessionAgent(session) === 'codex') {
    const contextTokens = getLatestCodexContextTokens(getRuntimeSessionId(session));
    if (contextTokens > 0 && contextTokens !== session.totalUsage?.contextTokens) {
      session.totalUsage = {
        ...(session.totalUsage || {}),
        contextTokens,
      };
      saveSession(session);
    }
  }
  const { recentMessages, olderChunks } = splitHistoryMessages(session.messages);
  historyLoadStates.set(ws, {
    sessionId: session.id,
    chunks: olderChunks,
    nextIndex: 0,
  });
  const effectiveCwd = session.cwd || activeProcesses.get(sessionId)?.cwd || null;

  // Detach ws from any previous session's process
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }

  wsSessionMap.set(ws, sessionId);

  // Read and clear unread flag
  const hadUnread = !!session.hasUnread;
  if (session.hasUnread) {
    session.hasUnread = false;
    saveSession(session);
  }

  wsSend(ws, {
    type: 'session_info',
    sessionId: session.id,
    messages: recentMessages,
    title: session.title,
    mode: session.permissionMode || 'yolo',
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    hasUnread: hadUnread,
    cwd: effectiveCwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    historyTotal: session.messages.length,
    historyBuffered: recentMessages.length,
    historyPending: olderChunks.length > 0,
    updated: session.updated,
    isRunning: activeProcesses.has(sessionId),
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });

  // Resume streaming if process is still active
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    entry.ws = ws;
    entry.wsDisconnectTime = null;
    plog('INFO', 'ws_resume_attach', {
      sessionId: sessionId.slice(0, 8),
      pid: entry.pid,
      responseLen: (entry.fullText || '').length,
    });
    wsSend(ws, {
      type: 'resume_generating',
      sessionId,
      startedAt: entry.startedAt,
      kind: pendingSlashCommands.get(sessionId)?.kind === 'compact' ? 'compacting' : 'response',
      text: entry.fullText || '',
      toolCalls: entry.toolCalls || [],
      steps: entry.assistantSteps || [],
    });
  }
}

function handleLoadSessionHistory(ws, sessionId) {
  const state = historyLoadStates.get(ws);
  if (!state || state.sessionId !== sessionId) return;
  const chunk = state.chunks[state.nextIndex];
  if (!chunk) return;
  state.nextIndex += 1;
  wsSend(ws, {
    type: 'session_history_chunk',
    sessionId,
    messages: chunk,
    remaining: Math.max(0, state.chunks.length - state.nextIndex),
  });
  if (state.nextIndex >= state.chunks.length) historyLoadStates.delete(ws);
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sanitizeUnicodeText(value) {
  const input = String(value || '');
  let result = '';
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = input.charCodeAt(i + 1);
      if (i + 1 < input.length && next >= 0xDC00 && next <= 0xDFFF) {
        result += input[i] + input[i + 1];
        i++;
        continue;
      }
      result += '\uFFFD';
      changed = true;
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
      changed = true;
      continue;
    }
    result += input[i];
  }
  return changed ? result : input;
}

function normalizeComparablePath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(basePath, targetPath) {
  if (!basePath || !targetPath) return false;
  let base;
  let target;
  try {
    base = normalizeComparablePath(basePath);
    target = normalizeComparablePath(targetPath);
  } catch {
    return false;
  }
  if (base === target) return true;
  const relativePath = path.relative(base, target);
  return !!relativePath && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function deleteClaudeLocalSession(claudeSessionId) {
  if (!claudeSessionId) return;
  const projectsDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const target = path.join(projectsDir, proj, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch {}
}

function deleteCodexLocalSession(session) {
  const threadId = session?.codexThreadId;
  if (!threadId) return { removedFiles: 0, removedDbRows: false };

  const rolloutPaths = new Set();
  if (session.importedRolloutPath) rolloutPaths.add(path.resolve(session.importedRolloutPath));
  try {
    for (const filePath of getCodexRolloutFiles()) {
      if (filePath.includes(threadId)) rolloutPaths.add(path.resolve(filePath));
    }
  } catch {}

  let removedFiles = 0;
  for (const filePath of rolloutPaths) {
    try {
      if (isPathInside(CODEX_SESSIONS_DIR, filePath) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removedFiles++;
      }
    } catch {}
  }

  let removedDbRows = false;
  try {
    const sqlitePath = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' });
    if (sqlitePath.status === 0) {
      const quotedThreadId = sqlQuote(threadId);
      const stateSql = [
        'PRAGMA foreign_keys = ON;',
        `DELETE FROM thread_dynamic_tools WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM stage1_outputs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`,
        `DELETE FROM threads WHERE id = ${quotedThreadId};`,
      ].join(' ');
      const stateResult = spawnSync('sqlite3', [CODEX_STATE_DB_PATH, stateSql], { stdio: 'ignore' });
      if (stateResult.status === 0) removedDbRows = true;

      if (fs.existsSync(CODEX_LOG_DB_PATH)) {
        spawnSync('sqlite3', [CODEX_LOG_DB_PATH, `DELETE FROM logs WHERE thread_id = ${quotedThreadId};`], { stdio: 'ignore' });
      }
    }
  } catch {}

  return { removedFiles, removedDbRows };
}

function deleteOpencodeLocalSession(session) {
  const opencodeSessionId = String(session?.opencodeSessionId || '').trim();
  if (!opencodeSessionId) return false;
  try {
    const cliSpec = getOpencodeCliSpec(['session', 'delete', opencodeSessionId]);
    const result = spawnSync(cliSpec.command, cliSpec.args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function handleDeleteSession(ws, sessionId) {
  pendingSlashCommands.delete(sessionId);
  pendingCompactRetries.delete(sessionId);
  if (activeProcesses.has(sessionId)) {
    const entry = activeProcesses.get(sessionId);
    try { killProcess(entry.pid); } catch {}
    if (entry.tailer) entry.tailer.stop();
    activeProcesses.delete(sessionId);
    if (entry.ws) wsSend(entry.ws, { type: 'done', sessionId });
  }
  cleanRunDir(sessionId);
  try {
    const p = sessionPath(sessionId);
    const session = loadSession(sessionId);
    const sessionAgent = getSessionAgent(session);
    for (const attachmentId of collectSessionAttachmentIds(session)) {
      removeAttachmentById(attachmentId);
    }
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (sessionAgent === 'codex') {
      const result = deleteCodexLocalSession(session);
      plog('INFO', 'codex_local_session_deleted', {
        sessionId: sessionId.slice(0, 8),
        threadId: session?.codexThreadId || null,
        removedFiles: result.removedFiles,
        removedDbRows: result.removedDbRows,
      });
    } else if (sessionAgent === 'opencode') {
      const removed = deleteOpencodeLocalSession(session);
      plog('INFO', 'opencode_local_session_deleted', {
        sessionId: sessionId.slice(0, 8),
        opencodeSessionId: session?.opencodeSessionId || null,
        removed,
      });
    } else if (sessionAgent === 'kimi') {
      plog('INFO', 'kimi_session_deleted', {
        sessionId: sessionId.slice(0, 8),
        kimiSessionId: session?.kimiSessionId || null,
      });
    } else if (sessionAgent === 'codebuddy') {
      plog('INFO', 'codebuddy_session_deleted', {
        sessionId: sessionId.slice(0, 8),
        codebuddySessionId: session?.codebuddySessionId || null,
      });
    } else {
      deleteClaudeLocalSession(session?.claudeSessionId || null);
    }
    sendSessionList(ws);
  } catch {
    wsSend(ws, { type: 'error', message: 'Failed to delete session' });
  }
}

function handleRenameSession(ws, sessionId, title) {
  if (!sessionId || !title) return;
  const session = loadSession(sessionId);
  if (session) {
    session.title = sanitizeUnicodeText(title).slice(0, 100);
    session.updated = new Date().toISOString();
    saveSession(session);
    sendSessionList(ws);
    wsSend(ws, { type: 'session_renamed', sessionId, title: session.title });
  }
}

		function handleSetMode(ws, sessionId, mode) {
		  const VALID_MODES = ['default', 'plan', 'yolo'];
		  if (!mode || !VALID_MODES.includes(mode)) return;
		  if (sessionId) {
		    const session = loadSession(sessionId);
		    if (session) {
		      session.permissionMode = mode;
		      // Same rule as /mode: don't clear runtime context on mode changes.
		      session.updated = new Date().toISOString();
		      saveSession(session);
		    }
		  }
		  wsSend(ws, { type: 'mode_changed', mode });
		}

function handleDisconnect(ws, wsId) {
  const affectedSessions = [];
  for (const [sid, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
      affectedSessions.push({ sessionId: sid.slice(0, 8), pid: entry.pid });
    }
  }
  wsSessionMap.delete(ws);
  plog('INFO', 'ws_disconnect', { wsId, activeProcessesAffected: affectedSessions });
}

function handleDetachView(ws) {
  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) {
      entry.ws = null;
      entry.wsDisconnectTime = new Date().toISOString();
    }
  }
  wsSessionMap.delete(ws);
}

function handleAbort(ws) {
  const sessionId = wsSessionMap.get(ws);
  if (!sessionId) return;
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  plog('INFO', 'user_abort', { sessionId: sessionId.slice(0, 8), pid: entry.pid });
  if (IS_WIN) {
    killProcess(entry.pid, true);
  } else {
    killProcess(entry.pid);
    setTimeout(() => {
      const current = activeProcesses.get(sessionId);
      if (current?.pid === entry.pid) killProcess(entry.pid, true);
    }, 3000);
  }
  // Process exit handling or the PID monitor will complete the session cleanup.
}

// === Runtime Message Handler ===
function handleMessage(ws, msg, options = {}) {
  const { text, sessionId, mode } = msg;
  const { hideInHistory = false } = options;
  const rawTextValue = typeof text === 'string' ? text : '';
  const textValue = sanitizeUnicodeText(rawTextValue);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, MAX_MESSAGE_ATTACHMENTS) : [];
  const normalizedText = textValue.trim();
  const resolvedAttachments = resolveMessageAttachments(attachments);
  if (attachments.length > 0 && resolvedAttachments.length === 0) {
    return wsSend(ws, { type: 'error', message: '图片附件已过期或不可用，请重新上传后再发送。' });
  }
  if (!normalizedText && resolvedAttachments.length === 0) return;
  if (rawTextValue !== textValue) {
    plog('WARN', 'message_unicode_sanitized', {
      sessionId: sessionId ? String(sessionId).slice(0, 8) : null,
      originalLength: rawTextValue.length,
      sanitizedLength: textValue.length,
    });
  }

  const savedAttachments = resolvedAttachments.map((attachment) => ({
    id: attachment.id,
    kind: 'image',
    filename: attachment.filename,
    mime: attachment.mime,
    size: attachment.size,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
    storageState: attachment.storageState,
  }));

  if (sessionId && activeProcesses.has(sessionId)) {
    return wsSend(ws, { type: 'error', message: '正在处理中，请先点击停止按钮。' });
  }

  const requestStartedAt = Date.now();

  const derivedTitle = normalizedText
    ? textValue.slice(0, 60).replace(/\n/g, ' ')
    : `图片: ${savedAttachments[0]?.filename || 'image'}`;

  let session;
  if (sessionId) session = loadSession(sessionId);
  if (!session) {
    const id = crypto.randomUUID();
    const agent = normalizeAgent(msg.agent);
    const resolvedCwd = resolveAgentDefaultCwd(agent);
    const runtimeField = getRuntimeSessionField(agent);
    session = {
      id,
      title: derivedTitle,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      agent,
      [runtimeField]: null,
      model: resolveAgentDefaultSessionModel(agent),
      permissionMode: mode || 'yolo',
      totalCost: 0,
      totalUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      messages: [],
      cwd: resolvedCwd,
    };
  }
  normalizeSession(session);

  if (normalizedText.startsWith('/') && resolvedAttachments.length > 0) {
    return wsSend(ws, { type: 'error', message: '命令消息暂不支持同时附带图片。请先发送图片说明，再单独使用 /model 或 /mode。' });
  }

  if (mode && ['default', 'plan', 'yolo'].includes(mode)) {
    session.permissionMode = mode;
  }

  if (!hideInHistory && normalizedText !== '/compact' && getRuntimeSessionId(session)) {
    pendingCompactRetries.set(session.id, { text: normalizedText, mode: session.permissionMode || 'yolo', reason: 'normal' });
  }

  const shouldUpdateTitle = session.title === 'New Chat' || session.title === 'Untitled';
  if (shouldUpdateTitle) {
    session.title = derivedTitle;
  }

  if (!hideInHistory) {
    session.messages.push({
      role: 'user',
      content: textValue,
      attachments: savedAttachments,
      timestamp: new Date().toISOString(),
    });
  }
  session.updated = new Date().toISOString();
  saveSession(session);

  const currentSessionId = session.id;

  for (const [, entry] of activeProcesses) {
    if (entry.ws === ws) entry.ws = null;
  }
  wsSessionMap.set(ws, currentSessionId);

  if (!sessionId) {
    wsSend(ws, {
      type: 'session_info',
      sessionId: currentSessionId,
      messages: session.messages,
      title: session.title,
      mode: session.permissionMode || 'yolo',
      model: sessionModelLabel(session),
      agent: getSessionAgent(session),
      cwd: session.cwd || null,
      totalCost: session.totalCost || 0,
      totalUsage: session.totalUsage || null,
      updated: session.updated,
      hasUnread: false,
      historyPending: false,
      isRunning: false,
      taskMode: session.taskMode || 'local',
      sshHostId: session.sshHostId || '',
      remoteCwd: session.remoteCwd || '',
    });
  }
  sendSessionList(ws);
  if (shouldUpdateTitle) {
    wsSend(ws, { type: 'session_renamed', sessionId: currentSessionId, title: session.title });
  }

  const spawnSpec = buildSpawnSpec(session, { attachments: resolvedAttachments, text: textValue });
  if (spawnSpec?.error) {
    return wsSend(ws, { type: 'error', message: spawnSpec.error });
  }

  // === Detached process with file-based I/O ===
  const dir = runDir(currentSessionId);
  fs.mkdirSync(dir, { recursive: true });

  const inputPath = path.join(dir, 'input.txt');
  const outputPath = path.join(dir, 'output.jsonl');
  const errorPath = path.join(dir, 'error.log');

  const stdinMode = spawnSpec.stdinMode || ((isClaudeSession(session) && resolvedAttachments.length > 0) ? 'stream-json' : 'file');
  const streamJsonFormat = spawnSpec.streamJsonFormat || 'claude-message';

  if (stdinMode === 'stream-json') {
    const content = [];
    if (textValue) content.push({ type: 'text', text: textValue });
    for (const attachment of resolvedAttachments) {
      const data = fs.readFileSync(attachment.path).toString('base64');
      if (streamJsonFormat === 'kimi-message') {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${attachment.mime};base64,${data}`,
          },
        });
      } else {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mime,
            data,
          },
        });
      }
    }
    const payload = streamJsonFormat === 'kimi-message'
      ? {
          role: 'user',
          content: content.length <= 1 && content[0]?.type === 'text'
            ? content[0].text
            : content,
        }
      : {
          type: 'user',
          message: {
            role: 'user',
            content,
          },
        };
    fs.writeFileSync(inputPath, `${JSON.stringify(payload)}\n`);
  } else if (stdinMode === 'file') {
    fs.writeFileSync(inputPath, textValue);
  }

  const outputFd = fs.openSync(outputPath, 'w');
  const errorFd = fs.openSync(errorPath, 'w');

  let proc;
  let stdinSource = null;
  let spawnSettled = false;
  let parentOutputClosed = false;
  let parentErrorClosed = false;
  let parentInputClosed = false;

  function closeFdQuietly(fd) {
    if (typeof fd !== 'number') return;
    try { fs.closeSync(fd); } catch {}
  }

  function closeParentStreams() {
    if (!parentInputClosed && typeof stdinSource === 'number') {
      closeFdQuietly(stdinSource);
      parentInputClosed = true;
    }
    if (!parentOutputClosed) {
      closeFdQuietly(outputFd);
      parentOutputClosed = true;
    }
    if (!parentErrorClosed) {
      closeFdQuietly(errorFd);
      parentErrorClosed = true;
    }
  }

  function handleSpawnFailure(err) {
    if (spawnSettled) return;
    spawnSettled = true;
    closeParentStreams();
    cleanRunDir(currentSessionId);
    plog('ERROR', 'process_spawn_fail', {
      sessionId: currentSessionId.slice(0, 8),
      agent: getSessionAgent(session),
      error: err?.message || 'Unknown spawn error',
    });
    const agent = getSessionAgent(session);
    wsSend(ws, {
      type: 'error',
      message: formatRuntimeError(agent, err?.message || 'Unknown spawn error', { exitCode: null, signal: null }),
    });
    wsSend(ws, {
      type: 'done',
      sessionId: currentSessionId,
      costUsd: null,
      durationMs: Math.max(0, Date.now() - requestStartedAt),
    });
    sendSessionList(ws);
  }

  const fileChangeBaseline = getSessionAgent(session) === 'codex'
    ? getGitWorkingTreeStats(spawnSpec.cwd)
    : new Map();

  try {
    if (stdinMode === 'stream-json') {
      // stream-json requires an open pipe (not a closed file) so Claude doesn't exit on EOF
      stdinSource = 'pipe';
    } else if (stdinMode === 'file') {
      stdinSource = fs.openSync(inputPath, 'r');
    } else {
      stdinSource = 'ignore';
    }
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      env: spawnSpec.env,
      cwd: spawnSpec.cwd,
      stdio: [stdinSource, outputFd, errorFd],
      detached: !IS_WIN,
      windowsHide: true,
    });
    proc.once('error', handleSpawnFailure);
    if (stdinMode === 'stream-json') {
      // Write the stream-json message then close stdin so Claude knows input is done
      proc.stdin.write(fs.readFileSync(inputPath));
      proc.stdin.end();
    } else if (stdinMode === 'file') {
      closeFdQuietly(stdinSource);
      parentInputClosed = true;
    }
    if (!Number.isInteger(proc.pid) || proc.pid <= 0) {
      return handleSpawnFailure(new Error(`${getSessionAgent(session)} process did not start correctly`));
    }
  } catch (err) {
    return handleSpawnFailure(err);
  }

  closeParentStreams();
  spawnSettled = true;

  const runtimeId = getRuntimeSessionId(session);
  const processStartMarker = getProcessSnapshot(proc.pid).startMarker;
  fs.writeFileSync(path.join(dir, 'pid'), String(proc.pid));
  writeRunProcessMeta(dir, {
    pid: proc.pid,
    agent: getSessionAgent(session),
    runtimeId,
    processStartMarker,
    startedAt: requestStartedAt,
  });
  proc.unref(); // Process survives Node.js exit

  plog('INFO', 'process_spawn', {
    sessionId: currentSessionId.slice(0, 8),
    pid: proc.pid,
    agent: getSessionAgent(session),
    runtimeId,
    processStartMarker,
    mode: spawnSpec.mode,
    model: session.model || 'default',
    resume: spawnSpec.resume,
    args: spawnSpec.args.join(' '),
  });

  // Fast exit detection (while Node.js is running)
  proc.on('exit', (code, signal) => {
    entry.childExited = true;
    if (entry.protocolExitTimer) {
      clearTimeout(entry.protocolExitTimer);
      entry.protocolExitTimer = null;
    }
    plog('INFO', 'process_exit_event', {
      sessionId: currentSessionId.slice(0, 8),
      pid: proc.pid,
      exitCode: code,
      signal: signal,
    });
    // Small delay to ensure file is fully flushed
    setTimeout(() => handleProcessComplete(currentSessionId, code, signal), 300);
  });

  const entry = {
    pid: proc.pid,
    ws,
    agent: getSessionAgent(session),
    runtimeId,
    processStartMarker,
    startedAt: requestStartedAt,
    identityCheck: false,
    cwd: spawnSpec.cwd,
    fullText: '',
    attachments: resolvedAttachments,
    toolCalls: [],
    assistantSteps: [],
    lastCost: null,
    lastUsage: null,
    lastError: null,
    errorSent: false,
    tailer: null,
    fileChangeBaseline,
  };
  activeProcesses.set(currentSessionId, entry);
  sendSessionList(ws);

  // Tail the output file for real-time streaming
  entry.tailer = new FileTailer(outputPath, (line) => {
    try {
      const event = JSON.parse(line);
      processRuntimeEvent(entry, event, currentSessionId);
      scheduleProtocolProcessExit(currentSessionId, entry);
    } catch {}
  });
  entry.tailer.start();
}

function truncateObj(obj, maxLen) {
  const s = JSON.stringify(obj);
  if (s.length <= maxLen) return obj;
  return s.slice(0, maxLen) + '...';
}

function safeJsonParse(input) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return input;
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return input;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

function sanitizeToolInput(toolName, input) {
  const parsed = safeJsonParse(input);
  if (toolName === 'AskUserQuestion') {
    return parsed;
  }
  return truncateObj(parsed, 500);
}

function getGitWorkingTreeStats(cwd) {
  const stats = new Map();
  if (!cwd) return stats;
  const normalizeKey = (filePath) => {
    const absolute = path.resolve(cwd, filePath);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  try {
    const diff = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--numstat', 'HEAD', '--'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (diff.status === 0) {
      for (const line of String(diff.stdout || '').split(/\r?\n/)) {
        const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!match || match[1] === '-' || match[2] === '-') continue;
        stats.set(normalizeKey(match[3]), { additions: Number(match[1]), deletions: Number(match[2]) });
      }
    }
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (untracked.status === 0) {
      for (const relativePath of String(untracked.stdout || '').split('\0').filter(Boolean)) {
        try {
          const content = fs.readFileSync(path.resolve(cwd, relativePath), 'utf8');
          const additions = content ? content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length : 0;
          stats.set(normalizeKey(relativePath), { additions, deletions: 0 });
        } catch {}
      }
    }
  } catch {}
  return stats;
}

const {
  buildSpawnSpec,
  processRuntimeEvent,
} = createAgentRuntime({
  processEnv: process.env,
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
  resolveCodexContextTokens: (session) => getLatestCodexContextTokens(getRuntimeSessionId(session)),
  getGitWorkingTreeStats,
});

// === Check Update ===
function handleCheckUpdate(ws) {
  const localVersion = (() => {
    try {
      const cl = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
      const m = cl.match(/##\s*v([\d.]+)/) || cl.match(/\*\*v([\d.]+)\*\*/);
      if (m) return m[1];
    } catch {}
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch {}
    return 'unknown';
  })();

  const https = require('https');
  const options = {
    hostname: 'raw.githubusercontent.com',
    path: '/ZgDaniel/cc-web/main/CHANGELOG.md',
    headers: { 'User-Agent': 'cc-web-update-check' },
    timeout: 10000,
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode !== 200) {
        return wsSend(ws, { type: 'update_info', localVersion, error: `HTTP ${res.statusCode}` });
      }
      const m = body.match(/##\s*v([\d.]+)/) || body.match(/\*\*v([\d.]+)\*\*/);
      const latest = m ? m[1] : null;
      if (!latest) {
        return wsSend(ws, { type: 'update_info', localVersion, error: '无法解析远端版本号' });
      }
      const hasUpdate = latest !== localVersion;
      wsSend(ws, {
        type: 'update_info',
        localVersion,
        latestVersion: latest,
        hasUpdate,
        releaseUrl: 'https://github.com/ZgDaniel/cc-web',
      });
    });
  });
  req.on('error', (e) => {
    wsSend(ws, { type: 'update_info', localVersion, error: '网络请求失败: ' + e.message });
  });
  req.on('timeout', () => {
    req.destroy();
    wsSend(ws, { type: 'update_info', localVersion, error: '请求超时' });
  });
  req.end();
}

// === Native Session Import ===

const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'sessions');
const CODEX_STATE_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'state_5.sqlite');
const CODEX_LOG_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codex', 'logs_1.sqlite');
const OPENCODE_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.local', 'share', 'opencode', 'opencode.db');
const DIRECTORY_BROWSER_LIMIT = 200;

function resolveClaudeSessionLocalMeta(claudeSessionId) {
  if (!claudeSessionId) return null;
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter((dir) => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, dir)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const filePath = path.join(CLAUDE_PROJECTS_DIR, dir, `${sanitizeId(claudeSessionId)}.jsonl`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        let cwd = null;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed);
            if (entry.type === 'user' && entry.cwd) {
              cwd = entry.cwd;
              break;
            }
          } catch {}
        }
        return { cwd, projectDir: dir, filePath };
      } catch {}
    }
  } catch {}
  return null;
}

function parseJsonlToMessages(lines) {
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    if (entry.type === 'user') {
      const raw = entry.message?.content;
      let content = '';
      if (typeof raw === 'string') {
        content = raw;
      } else if (Array.isArray(raw)) {
        // skip tool_result blocks, only take text blocks
        content = raw
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('');
      }
      if (content.trim()) {
        messages.push({ role: 'user', content, timestamp: entry.timestamp || null });
      }
    } else if (entry.type === 'assistant') {
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      let content = '';
      const toolCalls = [];
      const steps = [];
      const pendingToolCalls = new Map();
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          content += b.text;
          const last = steps[steps.length - 1];
          if (last && last.type === 'text') last.content = `${last.content || ''}${b.text}`;
          else steps.push({ type: 'text', content: b.text });
        } else if (b.type === 'tool_use') {
          const tc = { type: 'tool_call', name: b.name, id: b.id, input: b.input, done: true };
          toolCalls.push(tc);
          steps.push(tc);
          pendingToolCalls.set(b.id, tc);
        } else if (b.type === 'tool_result') {
          const resultText = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((item) => item.text || '').join('\n')
              : JSON.stringify(b.content || '');
          const tc = pendingToolCalls.get(b.tool_use_id);
          if (tc) tc.result = resultText.slice(0, 2000);
        }
        // skip thinking blocks
      }
      if (content.trim() || toolCalls.length > 0) {
        messages.push({ role: 'assistant', content, toolCalls, steps, timestamp: entry.timestamp || null });
      }
    }
    // skip other types
  }
  return messages;
}

const {
  parseCodexRolloutLines,
  getCodexRolloutFiles,
  getLatestCodexContextTokens,
  getImportedCodexThreadIds,
  parseCodexRolloutFile,
  parseCodexRolloutMetaFile,
} = createCodexRolloutStore({
  codexSessionsDir: CODEX_SESSIONS_DIR,
  codexContextDirs: [path.join(CODEX_RUNTIME_HOME, 'sessions')],
  sessionsDir: SESSIONS_DIR,
  normalizeSession,
  sanitizeToolInput,
});

function getImportedSessionIds() {
  const imported = new Set();
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.claudeSessionId) imported.add(s.claudeSessionId);
      } catch {}
    }
  } catch {}
  return imported;
}

function canUseSqliteJson() {
  try {
    const result = spawnSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function readSqliteJsonRows(dbPath, sql) {
  if (!dbPath || !fs.existsSync(dbPath) || !canUseSqliteJson()) return [];
  try {
    const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    const stdout = String(result.stdout || '').trim();
    if (!stdout) return [];
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getImportedOpencodeSessionIds() {
  const imported = new Set();
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((file) => file.endsWith('.json'))) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (session.opencodeSessionId) imported.add(session.opencodeSessionId);
      } catch {}
    }
  } catch {}
  return imported;
}

function getOpencodeSessionListFromCli() {
  try {
    const cliSpec = getOpencodeCliSpec(['session', 'list', '--format', 'json', '--max-count', '200']);
    const result = spawnSync(cliSpec.command, cliSpec.args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    const stdout = String(result.stdout || '').trim();
    if (!stdout) return [];
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => ({
      sessionId: String(row.id || '').trim(),
      title: String(row.title || '').trim() || String(row.id || '').trim().slice(0, 20),
      cwd: String(row.directory || '').trim() || null,
      version: '',
      updatedAt: row.updated ? new Date(Number(row.updated)).toISOString() : null,
    })).filter((row) => row.sessionId);
  } catch {
    return [];
  }
}

function getOpencodeSessionListFromDb() {
  return readSqliteJsonRows(OPENCODE_DB_PATH, [
    'SELECT id, title, directory, version, time_updated AS timeUpdated',
    'FROM session',
    'WHERE time_archived IS NULL',
    'ORDER BY time_updated DESC',
    'LIMIT 200;',
  ].join(' ')).map((row) => ({
    sessionId: String(row.id || '').trim(),
    title: String(row.title || '').trim() || String(row.id || '').trim().slice(0, 20),
    cwd: String(row.directory || '').trim() || null,
    version: String(row.version || '').trim(),
    updatedAt: row.timeUpdated ? new Date(Number(row.timeUpdated)).toISOString() : null,
  })).filter((row) => row.sessionId);
}

function getOpencodeSessionList() {
  const cliItems = getOpencodeSessionListFromCli();
  if (cliItems.length > 0) return cliItems;
  return getOpencodeSessionListFromDb();
}

function getCodebuddyCliSpec(args = []) {
  if (process.platform === 'win32' && /\.ps1$/i.test(CODEBUDDY_PATH)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CODEBUDDY_PATH, ...args],
    };
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(CODEBUDDY_PATH)) {
    const commandLine = [quoteWindowsCmdArg(CODEBUDDY_PATH), ...args.map(quoteWindowsCmdArg)].join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
    };
  }
  return { command: CODEBUDDY_PATH, args };
}

function getCodebuddyModelListCliSpec(args = []) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(CODEBUDDY_PATH)) {
    const ps1Path = CODEBUDDY_PATH.replace(/\.(cmd|bat)$/i, '.ps1');
    if (fs.existsSync(ps1Path)) {
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, ...args],
      };
    }

    const cliDir = path.dirname(CODEBUDDY_PATH);
    const binPath = path.join(cliDir, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
    if (fs.existsSync(binPath)) {
      return {
        command: process.execPath,
        args: [binPath, ...args],
      };
    }
  }
  return getCodebuddyCliSpec(args);
}

function getOpencodeCliSpec(args = []) {
  if (process.platform === 'win32' && /\.ps1$/i.test(OPENCODE_PATH)) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OPENCODE_PATH, ...args],
    };
  }
  return { command: OPENCODE_PATH, args };
}

function getKimiShareDir() {
  const explicit = String(process.env.KIMI_SHARE_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(getHomeDir(), '.kimi');
}

function stripTomlStringLiteral(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^["'](.+?)["']$/);
  return match ? match[1] : value;
}

function stripTomlComment(rawLine) {
  let result = '';
  let quote = '';
  let escaped = false;
  for (const ch of String(rawLine || '')) {
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      result += ch;
      if (quote === '"' && ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      result += ch;
      continue;
    }
    if (ch === '#') break;
    result += ch;
  }
  return result.trim();
}

function splitTomlArrayItems(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  const body = text.slice(1, -1);
  const items = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      const item = current.trim();
      if (item) items.push(item);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) items.push(tail);
  return items;
}

function parseKimiTomlValue(rawValue) {
  const value = stripTomlComment(rawValue);
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return stripTomlStringLiteral(value);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitTomlArrayItems(value).map((item) => stripTomlStringLiteral(item));
  }
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

function parseKimiTomlConfig(rawToml) {
  const parsed = {
    default_model: '',
    providers: {},
    models: {},
    services: {},
  };
  let sectionType = '';
  let sectionName = '';

  for (const rawLine of String(rawToml || '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;
    if (/^\s*\[\[/.test(line)) {
      sectionType = '';
      sectionName = '';
      continue;
    }

    let match = line.match(/^\s*\[providers\.(?:"([^"]+)"|'([^']+)'|([^[\]\s#]+))\]\s*$/);
    if (match) {
      sectionType = 'provider';
      sectionName = String(match[1] || match[2] || match[3] || '').trim();
      if (sectionName && !parsed.providers[sectionName]) parsed.providers[sectionName] = {};
      continue;
    }

    match = line.match(/^\s*\[models\.(?:"([^"]+)"|'([^']+)'|([^[\]\s#]+))\]\s*$/);
    if (match) {
      sectionType = 'model';
      sectionName = String(match[1] || match[2] || match[3] || '').trim();
      if (sectionName && !parsed.models[sectionName]) parsed.models[sectionName] = {};
      continue;
    }

    if (/^\s*\[services\.moonshot_search\]\s*$/.test(line)) {
      sectionType = 'service';
      sectionName = 'moonshot_search';
      parsed.services[sectionName] = parsed.services[sectionName] || {};
      continue;
    }

    if (/^\s*\[services\.moonshot_fetch\]\s*$/.test(line)) {
      sectionType = 'service';
      sectionName = 'moonshot_fetch';
      parsed.services[sectionName] = parsed.services[sectionName] || {};
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = parseKimiTomlValue(pair[2]);
    if (!sectionType) {
      if (key === 'default_model') parsed.default_model = String(value || '').trim();
      continue;
    }
    if (sectionType === 'provider' && sectionName) {
      parsed.providers[sectionName][key] = value;
      continue;
    }
    if (sectionType === 'model' && sectionName) {
      parsed.models[sectionName][key] = value;
      continue;
    }
    if (sectionType === 'service' && sectionName) {
      parsed.services[sectionName][key] = value;
    }
  }

  return parsed;
}

function normalizeKimiConfigShape(rawConfig, options = {}) {
  const providers = rawConfig?.providers && typeof rawConfig.providers === 'object' ? rawConfig.providers : {};
  const models = rawConfig?.models && typeof rawConfig.models === 'object' ? rawConfig.models : {};
  const services = rawConfig?.services && typeof rawConfig.services === 'object' ? rawConfig.services : {};
  const modelNames = Object.keys(models).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const requestedDefaultModel = String(rawConfig?.default_model || rawConfig?.defaultModel || '').trim();
  const defaultModel = modelNames.includes(requestedDefaultModel) ? requestedDefaultModel : (modelNames[0] || requestedDefaultModel || '');
  const activeModel = defaultModel ? (models[defaultModel] || null) : null;
  const providerName = String(activeModel?.provider || '').trim();
  const provider = providerName ? (providers[providerName] || {}) : {};
  const parsedMaxContext = parseInt(activeModel?.max_context_size ?? activeModel?.maxContextSize ?? '', 10);
  const searchService = services.moonshot_search || {};
  const fetchService = services.moonshot_fetch || {};

  return {
    sourceFound: !!options.sourceFound,
    sourcePath: options.sourcePath || '',
    defaultModel,
    models: modelNames,
    providerName,
    providerType: String(provider?.type || '').trim(),
    apiBase: String(provider?.base_url || provider?.baseUrl || '').trim(),
    apiKey: String(provider?.api_key || provider?.apiKey || ''),
    modelName: String(activeModel?.model || '').trim(),
    maxContextSize: Number.isFinite(parsedMaxContext) && parsedMaxContext > 0 ? parsedMaxContext : '',
    capabilities: normalizeKimiCapabilityList(activeModel?.capabilities),
    searchBase: String(searchService?.base_url || searchService?.baseUrl || '').trim(),
    searchApiKey: String(searchService?.api_key || searchService?.apiKey || ''),
    fetchBase: String(fetchService?.base_url || fetchService?.baseUrl || '').trim(),
    fetchApiKey: String(fetchService?.api_key || fetchService?.apiKey || ''),
  };
}

function readKimiConfigFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (/\.json$/i.test(filePath)) {
    return normalizeKimiConfigShape(JSON.parse(raw), { sourceFound: true, sourcePath: filePath });
  }
  return normalizeKimiConfigShape(parseKimiTomlConfig(raw), { sourceFound: true, sourcePath: filePath });
}

function readKimiLocalConfigFile() {
  const shareDir = getKimiShareDir();
  const tomlPath = path.join(shareDir, 'config.toml');
  if (fs.existsSync(tomlPath)) {
    try {
      return readKimiConfigFromFile(tomlPath);
    } catch {}
  }

  const legacyJsonPath = path.join(shareDir, 'config.json');
  if (fs.existsSync(legacyJsonPath)) {
    try {
      return readKimiConfigFromFile(legacyJsonPath);
    } catch {}
  }

  return {
    sourceFound: false,
    sourcePath: tomlPath,
    defaultModel: '',
    models: [],
    providerName: '',
    providerType: '',
    apiBase: '',
    apiKey: '',
    modelName: '',
    maxContextSize: '',
    capabilities: [],
    searchBase: '',
    searchApiKey: '',
    fetchBase: '',
    fetchApiKey: '',
  };
}

function getKimiEffectiveModelCatalog() {
  const kimiConfig = loadKimiConfig();
  if (kimiConfig.mode === 'custom') {
    const activeProfile = resolveActiveKimiProfile(kimiConfig);
    if (!activeProfile) {
      return {
        sourceKind: 'custom',
        sourceFound: false,
        sourcePath: '',
        models: [],
        defaultModel: '',
        profileName: '',
      };
    }
    return {
      sourceKind: 'custom',
      sourceFound: true,
      sourcePath: `cc-web Kimi Profile「${activeProfile.name}」`,
      models: (activeProfile.models || []).map((model) => model.name).filter(Boolean),
      defaultModel: activeProfile.defaultModel || activeProfile.models[0]?.name || '',
      profileName: activeProfile.name,
    };
  }

  const localConfig = readKimiLocalConfigFile();
  return {
    sourceKind: 'local',
    sourceFound: !!localConfig.sourceFound,
    sourcePath: localConfig.sourcePath || '',
    models: Array.isArray(localConfig.models) ? [...localConfig.models] : [],
    defaultModel: localConfig.defaultModel || '',
    profileName: '',
  };
}

function listKimiModels() {
  try {
    const catalog = getKimiEffectiveModelCatalog();
    if (catalog.models.length > 0) {
      return { success: true, models: catalog.models, message: '' };
    }
    if (catalog.sourceKind === 'custom') {
      return {
        success: false,
        models: [],
        message: catalog.profileName
          ? `Kimi Profile「${catalog.profileName}」未配置可用模型。`
          : 'Kimi 自定义配置缺少已激活的 Profile。',
      };
    }
    if (catalog.sourceFound) {
      return {
        success: false,
        models: [],
        message: `已读取 Kimi 配置，但未发现可用模型定义：${catalog.sourcePath}`,
      };
    }
    return {
      success: false,
      models: [],
      message: `未找到 Kimi 配置文件：${catalog.sourcePath}`,
    };
  } catch (error) {
    return {
      success: false,
      models: [],
      message: formatRuntimeError('kimi', String(error?.message || error || '无法读取模型列表')),
    };
  }
}

const CODEBUDDY_MODEL_LIST_TIMEOUT_MS = 45000;
const CODEBUDDY_MODEL_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const codebuddyModelListCache = {
  expiresAt: 0,
  pending: null,
  result: null,
};

function parseCodebuddyModelList(rawText) {
  const models = [];
  const seen = new Set();

  function pushModel(entry) {
    const id = String(entry?.id || '').replace(/`/g, '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const label = String(entry?.label || '').trim() || id;
    models.push({
      id,
      label,
      current: !!entry?.current,
      credits: String(entry?.credits || '').trim(),
    });
  }

  String(rawText || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return;

    const columns = trimmed
      .split('|')
      .slice(1, -1)
      .map((part) => part.trim());

    if (columns.length < 2) return;
    if (columns.every((column) => !column || /^[-:]+$/.test(column.replace(/\s+/g, '')))) return;

    const first = columns[0] || '';
    const second = columns[1] || '';
    if ((/模型|model/i.test(first) && /^id$/i.test(second)) || /^模型名称$/i.test(first)) return;

    const label = first
      .replace(/←/g, ' ')
      .replace(/[（(]\s*当前\s*[)）]/g, ' ')
      .replace(/当前/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const id = second.replace(/`/g, '').trim();
    if (!id || /^id$/i.test(id)) return;

    pushModel({
      id,
      label: label || id,
      current: /当前/.test(columns.join(' ')),
    });
  });

  if (models.length > 0) return models;

  String(rawText || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const inlineTokens = trimmed.match(/`([^`]+)`/g);
    if (!inlineTokens) return;
    inlineTokens.forEach((token) => {
      const id = token.slice(1, -1).trim();
      if (!id) return;
      pushModel({ id, label: id, current: false });
    });
  });

  return models;
}

function getCodebuddyPackageRoots() {
  const roots = [];
  const seen = new Set();

  function pushRoot(candidate) {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    try {
      if (fs.existsSync(value) && fs.statSync(value).isDirectory()) roots.push(value);
    } catch {}
  }

  if (/[\\/]/.test(CODEBUDDY_PATH)) {
    const cliDir = path.dirname(CODEBUDDY_PATH);
    pushRoot(path.join(cliDir, 'node_modules', '@tencent-ai', 'codebuddy-code'));
    pushRoot(path.resolve(cliDir, '..', 'lib', 'node_modules', '@tencent-ai', 'codebuddy-code'));
  }

  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  if (appData) {
    pushRoot(path.join(appData, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code'));
  }

  return roots;
}

function loadCodebuddyProductCatalogs() {
  const catalogs = [];
  for (const root of getCodebuddyPackageRoots()) {
    let names = [];
    try {
      names = fs.readdirSync(root).filter((name) => /^product(?:\.[^.]+)?\.json$/i.test(name));
    } catch {
      continue;
    }

    for (const name of names) {
      const filePath = path.join(root, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const items = Array.isArray(parsed?.models) ? parsed.models : [];
        const byId = new Map();
        items.forEach((item) => {
          const id = String(item?.id || '').trim();
          if (!id || byId.has(id)) return;
          byId.set(id, {
            id,
            label: String(item?.name || '').trim() || id,
            credits: String(item?.credits || '').trim(),
          });
        });
        if (byId.size > 0) {
          catalogs.push({ name, filePath, byId });
        }
      } catch {}
    }
  }
  return catalogs;
}

function pickCodebuddyProductCatalog(modelEntries) {
  const catalogs = loadCodebuddyProductCatalogs();
  if (catalogs.length === 0) return null;

  const modelIds = Array.from(new Set(
    (Array.isArray(modelEntries) ? modelEntries : [])
      .map((entry) => String(entry?.id || '').trim())
      .filter(Boolean)
  ));
  if (modelIds.length === 0) return null;

  let bestCatalog = null;
  let bestScore = null;
  for (const catalog of catalogs) {
    let matched = 0;
    let creditsMatched = 0;
    for (const id of modelIds) {
      const meta = catalog.byId.get(id);
      if (!meta) continue;
      matched += 1;
      if (meta.credits) creditsMatched += 1;
    }
    if (matched === 0) continue;
    const preference = /product\.internal\.json$/i.test(catalog.name)
      ? 3
      : /^product\.json$/i.test(catalog.name)
        ? 2
        : /product\.cloudhosted\.json$/i.test(catalog.name)
          ? 1
          : 0;
    const score = [matched, creditsMatched, preference];
    if (!bestScore || score[0] > bestScore[0]
      || (score[0] === bestScore[0] && score[1] > bestScore[1])
      || (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] > bestScore[2])) {
      bestCatalog = catalog;
      bestScore = score;
    }
  }

  return bestCatalog;
}

function enrichCodebuddyModelEntries(modelEntries) {
  const catalog = pickCodebuddyProductCatalog(modelEntries);
  if (!catalog) return modelEntries;

  return modelEntries.map((entry) => {
    const meta = catalog.byId.get(entry.id);
    if (!meta) return entry;
    return {
      ...entry,
      label: entry.label || meta.label || entry.id,
      credits: entry.credits || meta.credits || '',
    };
  });
}

function runCodebuddyCommandCapture(args = [], timeoutMs = CODEBUDDY_MODEL_LIST_TIMEOUT_MS) {
  const cliSpec = getCodebuddyModelListCliSpec(args);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    let child = null;
    try {
      const codebuddyConfig = loadCodebuddyConfig();
      const activeProfile = resolveActiveCodebuddyProfile(codebuddyConfig);
      child = spawn(cliSpec.command, cliSpec.args, {
        env: {
          ...process.env,
          ...buildCodebuddyEnvFromProfile(activeProfile),
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        error,
        stdout,
        stderr,
        status: null,
        signal: null,
        timedOut,
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid) killProcess(child.pid, true);
      const error = new Error(`Command timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish({
        error,
        stdout,
        stderr,
        status: null,
        signal: 'SIGKILL',
        timedOut,
      });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }

    child.on('error', (error) => {
      finish({
        error,
        stdout,
        stderr,
        status: null,
        signal: null,
        timedOut,
      });
    });

    child.on('close', (status, signal) => {
      finish({
        error: null,
        stdout,
        stderr,
        status,
        signal,
        timedOut,
      });
    });
  });
}

async function fetchCodebuddyModels() {
  try {
    const result = await runCodebuddyCommandCapture(['-p', '/model list']);
    if (!result.error && result.status === 0) {
      const models = enrichCodebuddyModelEntries(parseCodebuddyModelList(result.stdout));
      if (models.length > 0) {
        return { success: true, models, message: '' };
      }
      return {
        success: false,
        models: [],
        message: 'CodeBuddy 返回了模型列表，但当前输出格式未被识别。',
      };
    }

    if (result.timedOut) {
      return {
        success: false,
        models: [],
        message: `读取 CodeBuddy 模型列表超时（>${Math.round(CODEBUDDY_MODEL_LIST_TIMEOUT_MS / 1000)}s）。请稍后重试。`,
      };
    }

    if (result.error) {
      return {
        success: false,
        models: [],
        message: formatRuntimeError('codebuddy', String(result.error.message || result.error)),
      };
    }

    const raw = [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || '无法读取模型列表';
    return {
      success: false,
      models: [],
      message: formatRuntimeError('codebuddy', raw, { exitCode: result.status }),
    };
  } catch (error) {
    return {
      success: false,
      models: [],
      message: formatRuntimeError('codebuddy', String(error?.message || error || '无法读取模型列表')),
    };
  }
}

function listCodebuddyModels() {
  const now = Date.now();
  if (codebuddyModelListCache.result && codebuddyModelListCache.expiresAt > now) {
    return Promise.resolve(codebuddyModelListCache.result);
  }
  if (codebuddyModelListCache.pending) {
    return codebuddyModelListCache.pending;
  }

  const pending = fetchCodebuddyModels()
    .then((result) => {
      if (result?.success) {
        codebuddyModelListCache.result = result;
        codebuddyModelListCache.expiresAt = Date.now() + CODEBUDDY_MODEL_LIST_CACHE_TTL_MS;
      } else {
        codebuddyModelListCache.result = null;
        codebuddyModelListCache.expiresAt = 0;
      }
      return result;
    })
    .finally(() => {
      if (codebuddyModelListCache.pending === pending) {
        codebuddyModelListCache.pending = null;
      }
    });

  codebuddyModelListCache.pending = pending;
  return pending;
}

function listOpencodeModels() {
  try {
    const cliSpec = getOpencodeCliSpec(['models']);
    const result = spawnSync(cliSpec.command, cliSpec.args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      return {
        success: false,
        models: [],
        message: formatRuntimeError('opencode', String(result.error.message || result.error)),
      };
    }
    if (result.status !== 0) {
      const raw = [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || '无法读取模型列表';
      return {
        success: false,
        models: [],
        message: formatRuntimeError('opencode', raw, { exitCode: result.status }),
      };
    }
    const models = Array.from(new Set(
      String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    return { success: true, models, message: '' };
  } catch (error) {
    return {
      success: false,
      models: [],
      message: formatRuntimeError('opencode', String(error?.message || error || '无法读取模型列表')),
    };
  }
}

function loadOpencodeExport(sessionId) {
  const normalizedId = String(sessionId || '').trim();
  if (!normalizedId) return null;
  try {
    const cliSpec = getOpencodeCliSpec(['export', normalizedId]);
    const result = spawnSync(cliSpec.command, cliSpec.args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const stdout = String(result.stdout || '').trim();
    if (!stdout) return null;
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function getOpencodeModelRef(info) {
  const provider = String(info?.model?.providerID || info?.providerID || '').trim();
  const modelId = String(info?.model?.modelID || info?.modelID || '').trim();
  if (provider && modelId) return `${provider}/${modelId}`;
  return modelId || provider || null;
}

function getOpencodeMessageTimestamp(info) {
  const ts = info?.time?.completed || info?.time?.created || null;
  return ts ? new Date(Number(ts)).toISOString() : null;
}

function pushAssistantTextStep(steps, text) {
  if (!text) return;
  const last = steps[steps.length - 1];
  if (last && last.type === 'text') {
    last.content = `${last.content || ''}${text}`;
  } else {
    steps.push({ type: 'text', content: text });
  }
}

function buildOpencodeToolCall(part, fallbackId) {
  const partType = String(part?.type || '').trim().toLowerCase();
  const id = String(part?.callID || part?.callId || part?.id || fallbackId || '').trim() || `opencode-${Math.random().toString(36).slice(2)}`;
  if (partType === 'reasoning') {
    const text = String(part?.text || '');
    return {
      type: 'tool_call',
      name: 'Reasoning',
      id,
      kind: 'reasoning',
      input: null,
      result: text.slice(0, 2000),
      done: true,
      meta: {
        kind: 'reasoning',
        title: 'Reasoning',
        subtitle: text.slice(0, 120),
        status: null,
      },
    };
  }
  if (partType === 'patch') {
    const files = Array.isArray(part?.files) ? part.files : [];
    return {
      type: 'tool_call',
      name: 'Patch',
      id,
      kind: 'patch',
      input: truncateObj({ hash: part?.hash || '', files }, 500),
      result: files.join('\n').slice(0, 2000),
      done: true,
      meta: {
        kind: 'patch',
        title: 'Patch',
        subtitle: files.slice(0, 2).join(', '),
        status: null,
      },
    };
  }
  if (partType === 'file') {
    const filename = String(part?.filename || '');
    return {
      type: 'tool_call',
      name: 'File',
      id,
      kind: 'file',
      input: truncateObj({ filename, mime: part?.mime || '' }, 500),
      result: String(part?.url || filename || '').slice(0, 2000),
      done: true,
      meta: {
        kind: 'file',
        title: 'File',
        subtitle: filename,
        status: null,
      },
    };
  }
  const toolName = String(part?.tool || 'Tool');
  const result = String(part?.state?.output || part?.state?.error || JSON.stringify(truncateObj(part?.state || {}, 1200)) || '').slice(0, 2000);
  return {
    type: 'tool_call',
    name: toolName,
    id,
    kind: 'tool',
    input: sanitizeToolInput(toolName, part?.state?.input || null),
    result,
    done: true,
    meta: {
      kind: 'tool',
      title: 'Tool',
      subtitle: toolName,
      status: part?.state?.status || null,
    },
  };
}

function parseOpencodeExport(exported) {
  if (!exported || typeof exported !== 'object') return null;
  const messages = [];
  const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let totalCost = 0;
  let model = null;
  let updatedAt = null;

  for (const message of Array.isArray(exported.messages) ? exported.messages : []) {
    const info = message?.info || {};
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    if (!model) model = getOpencodeModelRef(info);
    const messageTs = getOpencodeMessageTimestamp(info);
    if (messageTs) updatedAt = messageTs;

    if (info.role === 'user') {
      const content = parts
        .filter((part) => part && part.type === 'text')
        .map((part) => part.text || '')
        .join('');
      if (content.trim()) {
        messages.push({
          role: 'user',
          content,
          timestamp: messageTs,
        });
      }
      continue;
    }

    if (info.role !== 'assistant') continue;

    const steps = [];
    const toolCalls = [];
    let content = '';
    for (const [index, part] of parts.entries()) {
      const partType = String(part?.type || '').trim().toLowerCase();
      if (partType === 'text' && part?.text) {
        content += part.text;
        pushAssistantTextStep(steps, part.text);
        continue;
      }
      if (!['reasoning', 'tool', 'patch', 'file'].includes(partType)) continue;
      const toolCall = buildOpencodeToolCall(part, `${info.id || 'msg'}-${index}`);
      toolCalls.push(toolCall);
      steps.push(toolCall);
    }

    if (content.trim() || toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content,
        toolCalls,
        steps,
        timestamp: messageTs,
      });
    }

    const usage = info?.tokens || {};
    totalUsage.inputTokens += Number(usage.input || 0) || 0;
    totalUsage.cachedInputTokens += Number(usage.cache?.read || 0) || 0;
    totalUsage.outputTokens += Number(usage.output || 0) || 0;
    totalCost += Number(info?.cost || 0) || 0;
  }

  return {
    title: String(exported.info?.title || '').trim() || String(exported.info?.id || '').trim().slice(0, 20),
    cwd: String(exported.info?.directory || '').trim() || null,
    updatedAt,
    model,
    totalUsage,
    totalCost,
    messages,
  };
}

function getLatestOpencodeAssistantTurn(opencodeSessionId) {
  const parsed = parseOpencodeExport(loadOpencodeExport(opencodeSessionId));
  if (!parsed) return null;
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const message = parsed.messages[i];
    if (message?.role === 'assistant') {
      return {
        content: message.content || '',
        toolCalls: message.toolCalls || [],
        steps: message.steps || [],
        model: parsed.model || null,
        totalUsage: parsed.totalUsage,
        totalCost: parsed.totalCost,
      };
    }
  }
  return null;
}

function sendAgentImportSessions(ws, agent, data) {
  wsSend(ws, { type: 'agent_import_sessions', agent: normalizeAgent(agent), data });
}

function handleListNativeSessions(ws, options = {}) {
  const groups = [];
  try {
    const imported = getImportedSessionIds();
    const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const dir of dirs) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      const sessionItems = [];
      try {
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(dirPath, f);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            // Find first user message for title
            let title = sessionId.slice(0, 20);
            let cwd = null;
            let updatedAt = null;
            let lastTs = null;
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              try {
                const e = JSON.parse(t);
                if (e.timestamp) lastTs = e.timestamp;
                if (e.type === 'user' && !cwd) {
                  cwd = e.cwd || null;
                  const raw = e.message?.content;
                  let text = '';
                  if (typeof raw === 'string') text = raw;
                  else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
                  if (text.trim()) title = text.trim().slice(0, 80).replace(/\n/g, ' ');
                }
              } catch {}
            }
            updatedAt = lastTs;
            sessionItems.push({ sessionId, title, cwd, updatedAt, alreadyImported: imported.has(sessionId) });
          } catch {}
        }
      } catch {}
      if (sessionItems.length > 0) {
        sessionItems.sort((a, b) => {
          if (!a.updatedAt) return 1;
          if (!b.updatedAt) return -1;
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
        groups.push({ dir, sessions: sessionItems });
      }
    }
  } catch {}
  if (options.unified) {
    sendAgentImportSessions(ws, 'claude', groups);
  } else {
    wsSend(ws, { type: 'native_sessions', groups });
  }
}

function handleImportNativeSession(ws, msg) {
  const { sessionId, projectDir } = msg;
  if (!sessionId || !projectDir) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId 或 projectDir' });
  }
  const filePath = path.join(CLAUDE_PROJECTS_DIR, String(projectDir), `${sanitizeId(sessionId)}.jsonl`);
  if (!isPathInside(CLAUDE_PROJECTS_DIR, filePath)) {
    return wsSend(ws, { type: 'error', message: '非法路径' });
  }
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch {
    return wsSend(ws, { type: 'error', message: '无法读取会话文件' });
  }
  const lines = content.split('\n');
  const messages = parseJsonlToMessages(lines);

  // Find or create cc-web session with this claudeSessionId
  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
        if (s.claudeSessionId === sessionId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  // Determine title and cwd from messages/raw
  let title = sessionId.slice(0, 20);
  let cwd = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.type === 'user') {
        if (!cwd) cwd = e.cwd || null;
        const raw = e.message?.content;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
        if (text.trim()) { title = text.trim().slice(0, 60).replace(/\n/g, ' '); break; }
      }
    } catch {}
  }

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const runtimeField = getRuntimeSessionField('claude');
  const session = {
    id,
    title,
    created: existingSession?.created || new Date().toISOString(),
    updated: pickFirstValidIsoTimestamp(getFileMtimeIso(filePath), existingSession?.updated, existingSession?.created) || new Date().toISOString(),
    agent: 'claude',
    [runtimeField]: sessionId,
    importedFrom: projectDir,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages,
    cwd: cwd || existingSession?.cwd || null,
  };
  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListCodexSessions(ws, options = {}) {
  const imported = getImportedCodexThreadIds();
  const items = [];
  const seen = new Set();
  for (const filePath of getCodexRolloutFiles()) {
    const parsed = parseCodexRolloutFile(filePath);
    if (!parsed?.meta?.threadId) continue;
    if (seen.has(parsed.meta.threadId)) continue;
    seen.add(parsed.meta.threadId);
    const title = parsed.meta.title || parsed.meta.threadId.slice(0, 20);
    items.push({
      threadId: parsed.meta.threadId,
      title,
      cwd: parsed.meta.cwd || null,
      updatedAt: parsed.meta.updatedAt || null,
      cliVersion: parsed.meta.cliVersion || '',
      source: parsed.meta.source || '',
      rolloutPath: filePath,
      alreadyImported: imported.has(parsed.meta.threadId),
    });
  }
  if (options.unified) {
    sendAgentImportSessions(ws, 'codex', items);
  } else {
    wsSend(ws, { type: 'codex_sessions', sessions: items });
  }
}

function handleImportCodexSession(ws, msg) {
  const threadId = String(msg?.threadId || '').trim();
  if (!threadId) {
    return wsSend(ws, { type: 'error', message: '缺少 threadId' });
  }

  let parsed = null;
  const requestedPath = msg?.rolloutPath ? path.resolve(String(msg.rolloutPath)) : '';
  if (requestedPath && isPathInside(CODEX_SESSIONS_DIR, requestedPath) && fs.existsSync(requestedPath)) {
    parsed = parseCodexRolloutFile(requestedPath);
  }
  if (!parsed) {
    for (const filePath of getCodexRolloutFiles()) {
      const candidate = parseCodexRolloutFile(filePath);
      if (candidate?.meta?.threadId === threadId) {
        parsed = candidate;
        break;
      }
    }
  }

  if (!parsed || parsed.meta.threadId !== threadId) {
    return wsSend(ws, { type: 'error', message: '未找到对应的 Codex 会话文件' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const s = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (s.codexThreadId === threadId) { existingSession = s; break; }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const runtimeField = getRuntimeSessionField('codex');
  const session = {
    id,
    title: parsed.meta.title || existingSession?.title || threadId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: pickFirstValidIsoTimestamp(parsed.meta.updatedAt, getFileMtimeIso(parsed.filePath), existingSession?.updated, existingSession?.created) || new Date().toISOString(),
    agent: 'codex',
    [runtimeField]: threadId,
    importedFrom: 'codex',
    importedRolloutPath: parsed.filePath,
    model: existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: parsed.messages,
    cwd: parsed.meta.cwd || existingSession?.cwd || null,
  };

  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListOpencodeSessions(ws, options = {}) {
  const imported = getImportedOpencodeSessionIds();
  const items = getOpencodeSessionList().map((session) => ({
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    version: session.version,
    alreadyImported: imported.has(session.sessionId),
  }));
  if (options.unified) {
    sendAgentImportSessions(ws, 'opencode', items);
  } else {
    wsSend(ws, { type: 'opencode_sessions', sessions: items });
  }
}

function handleImportOpencodeSession(ws, msg) {
  const opencodeSessionId = String(msg?.sessionId || '').trim();
  if (!opencodeSessionId) {
    return wsSend(ws, { type: 'error', message: '缺少 sessionId' });
  }

  const exported = loadOpencodeExport(opencodeSessionId);
  const parsed = parseOpencodeExport(exported);
  if (!exported || !parsed) {
    return wsSend(ws, { type: 'error', message: '无法读取对应的 OpenCode 会话' });
  }

  let existingSession = null;
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((file) => file.endsWith('.json'))) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (session.opencodeSessionId === opencodeSessionId) {
          existingSession = session;
          break;
        }
      } catch {}
    }
  } catch {}

  const id = existingSession ? existingSession.id : crypto.randomUUID();
  const runtimeField = getRuntimeSessionField('opencode');
  const session = {
    id,
    title: parsed.title || existingSession?.title || opencodeSessionId.slice(0, 20),
    created: existingSession?.created || new Date().toISOString(),
    updated: pickFirstValidIsoTimestamp(parsed.updatedAt, existingSession?.updated, existingSession?.created) || new Date().toISOString(),
    agent: 'opencode',
    [runtimeField]: opencodeSessionId,
    importedFrom: 'opencode',
    model: parsed.model || existingSession?.model || null,
    permissionMode: existingSession?.permissionMode || 'yolo',
    totalCost: parsed.totalCost || existingSession?.totalCost || 0,
    totalUsage: parsed.totalUsage || existingSession?.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    messages: parsed.messages,
    cwd: parsed.cwd || existingSession?.cwd || null,
  };

  saveSession(session);
  wsSessionMap.set(ws, id);
  wsSend(ws, {
    type: 'session_info',
    sessionId: id,
    messages: session.messages,
    title: session.title,
    mode: session.permissionMode,
    model: sessionModelLabel(session),
    agent: getSessionAgent(session),
    cwd: session.cwd,
    totalCost: session.totalCost || 0,
    totalUsage: session.totalUsage || null,
    updated: session.updated,
    hasUnread: false,
    historyPending: false,
    isRunning: false,
    taskMode: session.taskMode || 'local',
    sshHostId: session.sshHostId || '',
    remoteCwd: session.remoteCwd || '',
  });
  sendSessionList(ws);
}

function handleListAgentImportSessions(ws, msg) {
  const agent = normalizeAgent(msg?.agent);
  if (agent === 'codex') return handleListCodexSessions(ws, { unified: true });
  if (agent === 'claude') return handleListNativeSessions(ws, { unified: true });
  if (agent === 'opencode') return handleListOpencodeSessions(ws, { unified: true });
  wsSend(ws, { type: 'error', message: `当前 agent 暂不支持导入: ${agent}` });
}

function handleImportAgentSession(ws, msg) {
  const agent = normalizeAgent(msg?.agent);
  if (agent === 'codex') return handleImportCodexSession(ws, msg);
  if (agent === 'claude') return handleImportNativeSession(ws, msg);
  if (agent === 'opencode') return handleImportOpencodeSession(ws, msg);
  wsSend(ws, { type: 'error', message: `当前 agent 暂不支持导入: ${agent}` });
}

function addCwdSuggestion(map, cwd, meta = {}) {
  const raw = String(cwd || '').trim();
  if (!raw) return;
  const normalizedPath = path.normalize(raw);
  if (!normalizedPath) return;
  const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
  let item = map.get(key);
  if (!item) {
    item = {
      path: normalizedPath,
      title: '',
      updatedAt: null,
      totalCount: 0,
      importedCount: 0,
      unimportedCount: 0,
      sourceKinds: new Set(),
    };
    map.set(key, item);
  }
  item.totalCount += 1;
  if (meta.imported === false) item.unimportedCount += 1;
  else item.importedCount += 1;
  if (meta.sourceKind) item.sourceKinds.add(meta.sourceKind);
  if (meta.updatedAt) {
    const nextTs = new Date(meta.updatedAt).getTime();
    const prevTs = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
    if (!item.updatedAt || (Number.isFinite(nextTs) && nextTs > prevTs)) {
      item.updatedAt = meta.updatedAt;
      if (meta.title) item.title = meta.title;
    }
  }
  if (!item.title && meta.title) item.title = meta.title;
}

function collectCwdSuggestionItems(agent) {
  const targetAgent = normalizeAgent(agent);
  const items = new Map();

  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')));
        if (getSessionAgent(session) !== targetAgent) continue;
        if ((session.taskMode || 'local') !== 'local') continue;
        addCwdSuggestion(items, session.cwd, {
          title: session.title || '',
          updatedAt: session.updated || session.created || null,
          imported: true,
          sourceKind: 'cc-web',
        });
      } catch {}
    }
  } catch {}

  if (targetAgent === 'claude') {
    const imported = getImportedSessionIds();
    try {
      const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
        try { return fs.statSync(path.join(CLAUDE_PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        let files = [];
        try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch {}
        for (const f of files) {
          const sessionId = f.replace('.jsonl', '');
          if (imported.has(sessionId)) continue;
          const filePath = path.join(dirPath, f);
          try {
            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            let title = sessionId.slice(0, 20);
            let cwd = null;
            let updatedAt = null;
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const entry = JSON.parse(trimmed);
                if (entry.timestamp) updatedAt = entry.timestamp;
                if (entry.type === 'user') {
                  if (!cwd && entry.cwd) cwd = entry.cwd;
                  if (title === sessionId.slice(0, 20)) {
                    const raw = entry.message?.content;
                    let text = '';
                    if (typeof raw === 'string') text = raw;
                    else if (Array.isArray(raw)) text = raw.filter(b => b.type === 'text').map(b => b.text || '').join('');
                    if (text.trim()) title = text.trim().slice(0, 80).replace(/\n/g, ' ');
                  }
                }
              } catch {}
            }
            addCwdSuggestion(items, cwd, {
              title,
              updatedAt,
              imported: false,
              sourceKind: 'claude-native',
            });
          } catch {}
        }
      }
    } catch {}
  } else if (targetAgent === 'codex') {
    const imported = getImportedCodexThreadIds();
    const seen = new Set();
    for (const filePath of getCodexRolloutFiles()) {
      const meta = parseCodexRolloutMetaFile(filePath);
      const threadId = meta?.threadId;
      if (!threadId || seen.has(threadId) || imported.has(threadId)) continue;
      seen.add(threadId);
      addCwdSuggestion(items, meta.cwd, {
        title: meta.title || threadId.slice(0, 20),
        updatedAt: meta.updatedAt || null,
        imported: false,
        sourceKind: 'codex-rollout',
      });
    }
  } else if (targetAgent === 'opencode') {
    const imported = getImportedOpencodeSessionIds();
    for (const session of getOpencodeSessionList()) {
      if (imported.has(session.sessionId)) continue;
      addCwdSuggestion(items, session.cwd, {
        title: session.title || session.sessionId.slice(0, 20),
        updatedAt: session.updatedAt || null,
        imported: false,
        sourceKind: 'opencode-native',
      });
    }
  }

  return Array.from(items.values())
    .map((item) => ({ ...item, sourceKinds: Array.from(item.sourceKinds) }))
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
}

function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function getDirectoryRoots() {
  const roots = [];
  const seen = new Set();
  const pushRoot = (dirPath, label) => {
    if (!dirPath) return;
    let resolved;
    try { resolved = path.resolve(dirPath); } catch { return; }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(key);
    roots.push({ path: resolved, label: label || resolved });
  };

  const home = getHomeDir();
  pushRoot(home, 'Home');
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      pushRoot(drive, drive);
    }
  } else {
    pushRoot('/', '/');
  }
  return roots;
}

function findBrowsableDirectory(inputPath) {
  let target = String(inputPath || '').trim();
  if (!target) target = getHomeDir();
  try { target = path.resolve(target); } catch { target = getHomeDir(); }

  while (true) {
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return target;
    } catch {}
    const parent = path.dirname(target);
    if (!parent || parent === target) break;
    target = parent;
  }
  return getHomeDir();
}

function listBrowsableDirectories(dirPath) {
  try {
    const dirs = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    return {
      entries: dirs.slice(0, DIRECTORY_BROWSER_LIMIT).map((entry) => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
      })),
      truncated: dirs.length > DIRECTORY_BROWSER_LIMIT,
      error: '',
    };
  } catch (error) {
    return { entries: [], truncated: false, error: error.message || '目录读取失败' };
  }
}

function handleListCwdSuggestions(ws, msg) {
  const agent = normalizeAgent(msg?.agent);
  const items = collectCwdSuggestionItems(agent);
  wsSend(ws, { type: 'cwd_suggestions', agent, items });
}

function handleBrowseDirectories(ws, msg) {
  const requestedPath = String(msg?.path || '').trim();
  const fallbackPath = findBrowsableDirectory(requestedPath);
  const listResult = listBrowsableDirectories(fallbackPath);
  let error = listResult.error || '';

  if (!error && requestedPath) {
    try {
      const resolvedRequested = path.resolve(requestedPath);
      if (resolvedRequested !== fallbackPath) {
        error = '目录不存在或暂不可访问，已切换到最近可用的父目录。';
      }
    } catch {
      error = '目录路径无效，已切换到默认目录。';
    }
  }

  const parentPath = path.dirname(fallbackPath);
  wsSend(ws, {
    type: 'directory_browser',
    currentPath: fallbackPath,
    parentPath: parentPath === fallbackPath ? null : parentPath,
    roots: getDirectoryRoots(),
    entries: listResult.entries,
    truncated: !!listResult.truncated,
    error,
  });
}

// === Startup ===
recoverProcesses();
repairImportedSessionUpdatedAt();
repairDuplicateAssistantMessages();

// Periodic heartbeat: log active processes status every 60s
setInterval(() => {
  if (activeProcesses.size === 0) return;
  const procs = [];
  for (const [sid, entry] of activeProcesses) {
    const status = getLiveProcessStatus(entry);
    procs.push({
      sessionId: sid.slice(0, 8),
      pid: entry.pid,
      alive: status.alive,
      reason: status.reason,
      wsConnected: !!entry.ws,
      wsDisconnectTime: entry.wsDisconnectTime || null,
      responseLen: (entry.fullText || '').length,
    });
  }
  plog('INFO', 'heartbeat', { activeCount: procs.length, wsClients: wss.clients.size, processes: procs });
}, 60000);

plog('INFO', 'server_start', { port: PORT, host: HOST });

server.listen(PORT, HOST, () => {
  printAccessUrls();
});

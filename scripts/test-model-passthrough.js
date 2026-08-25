#!/usr/bin/env node
/**
 * 模型名直通测试 — 验证 Codex 和 Claude 在 spawn 时如何传递模型名
 *
 * 不发起真实 API 请求，只调用 buildSpawnSpec 检查 args 数组
 */

const { createAgentRuntime } = require('../lib/agent-runtime');

// --- Mock deps for createAgentRuntime ---
const processEnv = { ...process.env, HOME: process.env.HOME || process.env.USERPROFILE };

const MODEL_MAP = {
  opus: 'claude-opus-4-6[1m]',
  sonnet: 'claude-sonnet-4-6[1m]',
  haiku: 'claude-haiku-4-5-20251001',
};

const mockDeps = {
  processEnv,
  CLAUDE_PATH: 'claude',
  CODEX_PATH: 'codex',
  CODEBUDDY_PATH: 'codebuddy',
  KIMI_PATH: 'kimi',
  OPENCODE_PATH: 'opencode',
  MODEL_MAP,
  loadModelConfig: () => ({ mode: 'local', templates: [], activeTemplate: '', localSnapshot: {} }),
  applyCustomTemplateToSettings: () => {},
  loadCodexConfig: () => ({ mode: 'local', profiles: [], activeProfile: '' }),
  prepareCodexCustomRuntime: () => null,
  loadCodebuddyConfig: () => ({ mode: 'local', profiles: [], activeProfile: '' }),
  loadKimiConfig: () => ({ mode: 'local', profiles: [], activeProfile: '' }),
  prepareKimiCustomRuntime: () => null,
  wsSend: () => {},
  truncateObj: (obj) => obj,
  sanitizeToolInput: (name, input) => input,
  loadSession: () => null,
  saveSession: () => {},
  setRuntimeSessionId: () => {},
  getRuntimeSessionId: () => null,
  resolveCodexContextTokens: () => 0,
  getGitWorkingTreeStats: () => new Map(),
};

const runtime = createAgentRuntime(mockDeps);

// --- Test helpers ---
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passCount++;
  } else {
    console.log(`  ❌ ${message}`);
    failCount++;
  }
}

// On Windows, resolveWindowsCliCommand wraps through cmd.exe as a single string.
// On Linux/macOS, args stays as an array.
// We flatten everything into a single string for searching, plus also check array form.
function getAllArgsText(spec) {
  if (Array.isArray(spec.args)) {
    // Could be ['--model', 'dsv4', ...] or ['/d','/s','/c','codex exec --json ... --model dsv4 ...']
    return spec.args.map((a) => String(a)).join(' ');
  }
  return String(spec.args || '');
}

function findInArgs(spec, search) {
  const text = getAllArgsText(spec);
  return text.includes(search);
}

// Extract the value after --model from the full args text
function getModelArgValue(spec) {
  const text = getAllArgsText(spec);
  // Match --model <value> where value is the next token (space-delimited)
  // On Windows the whole thing is one string like: codex exec --json --dangerously-bypass... --model dsv4 exec resume ...
  // On Linux it's: codex,exec,--json,...,--model,dsv4,...
  const m = text.match(/--model\s+(\S+)/);
  return m ? m[1] : null;
}

console.log('\n========================================');
console.log('  Codex & Claude 模型名直通测试');
console.log('========================================\n');

// ========== CODEX TESTS ==========
console.log('▶ Codex 测试\n');

// Test 1: Codex 纯模型名 (无 thinking 后缀) — 原样直通
{
  const session = { agent: 'codex', model: 'dsv4', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'dsv4', `Codex 纯模型名 "dsv4" 应原样传给 --model (实际: "${modelVal}")`);
  assert(!findInArgs(spec, 'model_reasoning_effort'), 'Codex 无 thinking 后缀时不应有 model_reasoning_effort 参数');
  console.log('    [debug] args:', JSON.stringify(spec.args).slice(0, 200));
}

// Test 2: Codex 标准 base model (gpt-5.6-luna) — 原样直通
{
  const session = { agent: 'codex', model: 'gpt-5.6-luna', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'gpt-5.6-luna', `Codex "gpt-5.6-luna" 应原样传给 --model (实际: "${modelVal}")`);
}

// Test 3: Codex 带 thinking 后缀 — base 拆出，level 转为 config override
{
  const session = { agent: 'codex', model: 'gpt-5.6-luna(low)', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'gpt-5.6-luna', `Codex "gpt-5.6-luna(low)" 应拆出 base "gpt-5.6-luna" 给 --model (实际: "${modelVal}")`);
  assert(findInArgs(spec, 'model_reasoning_effort=low'), 'Codex thinking level "low" 应转为 model_reasoning_effort=low');
  assert(!findInArgs(spec, 'gpt-5.6-luna(low)'), 'Codex 不应把 "gpt-5.6-luna(low)" 整体传给 --model');
}

// Test 4: Codex 自定义/第三方模型名 — 原样直通
{
  const session = { agent: 'codex', model: 'deepseek-v3', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'deepseek-v3', `Codex "deepseek-v3" 应原样传给 --model (实际: "${modelVal}")`);
}

// Test 5: Codex 自定义模型名带 thinking — base 拆出
{
  const session = { agent: 'codex', model: 'deepseek-v3(high)', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'deepseek-v3', `Codex "deepseek-v3(high)" 应拆出 base "deepseek-v3" 给 --model (实际: "${modelVal}")`);
  assert(findInArgs(spec, 'model_reasoning_effort=high'), 'Codex thinking level "high" 应转为 model_reasoning_effort=high');
}

// Test 6: Codex 空模型名 — 不传 --model
{
  const session = { agent: 'codex', model: '', permissionMode: 'yolo' };
  const spec = runtime.buildCodexSpawnSpec(session);
  assert(!findInArgs(spec, '--model'), 'Codex 空模型名时不应传 --model 参数');
}

// ========== CLAUDE TESTS ==========
console.log('\n▶ Claude 测试\n');

// Test 7: Claude 真实模型名 (从 MODEL_MAP 映射后) — 原样传给 --model
{
  // Claude 的 /model 命令已经把 opus → claude-opus-4-6[1m] 存入 session.model
  // buildClaudeSpawnSpec 直接从 session.model 取，不再做映射
  const session = { agent: 'claude', model: 'claude-opus-4-6[1m]', permissionMode: 'yolo' };
  const spec = runtime.buildClaudeSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'claude-opus-4-6[1m]', `Claude session.model "claude-opus-4-6[1m]" 应原样传给 --model (实际: "${modelVal}")`);
}

// Test 8: Claude 如果直接传别名 "opus" — buildClaudeSpawnSpec 不会映射！直接原样传
{
  // 注意：映射发生在 /model 命令处理时 (server.js)，不在 buildClaudeSpawnSpec 中
  // 所以如果 session.model 直接是 "opus"，buildClaudeSpawnSpec 会原样传 "opus"
  const session = { agent: 'claude', model: 'opus', permissionMode: 'yolo' };
  const spec = runtime.buildClaudeSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'opus', `Claude session.model "opus" 会被原样传给 --model (实际: "${modelVal}") — 映射在 server /model 层`);
}

// Test 9: Claude 自定义模型名 — 原样传给 --model
{
  const session = { agent: 'claude', model: 'my-custom-claude-model', permissionMode: 'yolo' };
  const spec = runtime.buildClaudeSpawnSpec(session);
  const modelVal = getModelArgValue(spec);
  assert(modelVal === 'my-custom-claude-model', `Claude 自定义模型名应原样传给 --model (实际: "${modelVal}")`);
}

// Test 10: Claude 空模型名 — 不传 --model
{
  const session = { agent: 'claude', model: '', permissionMode: 'yolo' };
  const spec = runtime.buildClaudeSpawnSpec(session);
  assert(!findInArgs(spec, '--model'), 'Claude 空模型名时不应传 --model 参数');
}

// ========== Summary ==========
console.log('\n========================================');
console.log(`  结果: ${passCount} 通过, ${failCount} 失败`);
console.log('========================================\n');

if (failCount > 0) {
  process.exit(1);
}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodexRolloutStore } = require('../lib/codex-rollouts');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-context-'));
const codexSessionsDir = path.join(tempRoot, 'codex-sessions');
const sessionsDir = path.join(tempRoot, 'sessions');
const threadId = 'test-thread-context-usage';

try {
  fs.mkdirSync(codexSessionsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = path.join(codexSessionsDir, `rollout-${threadId}.jsonl`);
  const entries = [
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 404722, cached_input_tokens: 351232, output_tokens: 5545 },
          last_token_usage: { input_tokens: 53302, cached_input_tokens: 49920, output_tokens: 947 },
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 458995, cached_input_tokens: 404224, output_tokens: 7261 },
          last_token_usage: { input_tokens: 54273, cached_input_tokens: 52992, output_tokens: 1716 },
        },
      },
    },
  ];
  fs.writeFileSync(rolloutPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

  const store = createCodexRolloutStore({
    codexSessionsDir,
    sessionsDir,
    normalizeSession: (session) => session,
    sanitizeToolInput: (_name, input) => input,
  });

  assert.strictEqual(store.getLatestCodexContextTokens(threadId), 55989);
  assert.strictEqual(store.getLatestCodexContextTokens('missing-thread'), 0);

  const metaEntry = {
    type: 'session_meta',
    payload: { id: threadId, cwd: 'C:\\workspace\\demo' },
  };
  const userEntry = {
    type: 'event_msg',
    payload: { type: 'user_message', message: '检查目录加载速度', details: 'x'.repeat(1024 * 1024) },
  };
  const injectedContextEntry = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
    },
  };
  fs.writeFileSync(
    rolloutPath,
    `${JSON.stringify(metaEntry)}\n${JSON.stringify(injectedContextEntry)}\n${'x'.repeat(80 * 1024)}\n${JSON.stringify(userEntry)}\n`,
    'utf8'
  );
  const meta = store.parseCodexRolloutMetaFile(rolloutPath);
  assert.strictEqual(meta.threadId, threadId);
  assert.strictEqual(meta.cwd, 'C:\\workspace\\demo');
  assert.strictEqual(meta.title, '检查目录加载速度');
  console.log('context usage regression test passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const assert = require('assert');
const { createCodexRolloutStore } = require('../lib/codex-rollouts');

const store = createCodexRolloutStore({
  codexSessionsDir: '',
  sessionsDir: '',
  normalizeSession: (session) => session,
  sanitizeToolInput: (_name, input) => input,
});

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

const parsed = store.parseCodexRolloutLines([
  line('2026-07-21T00:00:00.000Z', 'event_msg', {
    type: 'user_message',
    message: '修复消息渲染',
  }),
  line('2026-07-21T00:00:01.000Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '我先检查相关代码。' }],
  }),
  line('2026-07-21T00:00:02.000Z', 'response_item', {
    type: 'function_call',
    name: 'shell_command',
    call_id: 'call-1',
    arguments: '{"command":"rg message"}',
  }),
  line('2026-07-21T00:00:03.000Z', 'response_item', {
    type: 'function_call_output',
    call_id: 'call-1',
    output: 'matched',
  }),
  line('2026-07-21T00:00:04.000Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '问题已经定位。' }],
  }),
  line('2026-07-21T00:00:05.000Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '修复完成。' }],
  }),
  line('2026-07-21T00:00:06.000Z', 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 200 },
      last_token_usage: { input_tokens: 700, cached_input_tokens: 500, output_tokens: 100 },
    },
  }),
]);

assert.strictEqual(parsed.messages.length, 2, '同一用户轮次不应拆成多条 assistant 消息');
const assistant = parsed.messages[1];
assert.strictEqual(assistant.role, 'assistant');
assert.strictEqual(assistant.content, '我先检查相关代码。\n\n问题已经定位。\n\n修复完成。');
assert.deepStrictEqual(assistant.steps.map((step) => step.type), ['text', 'tool_call', 'text']);
assert.strictEqual(assistant.steps[1].done, true);
assert.strictEqual(assistant.steps[2].content, '问题已经定位。\n\n修复完成。');
assert.strictEqual(parsed.totalUsage.contextTokens, 800, '上下文应使用最近一轮输入与输出，而不是累计 token');

console.log('Codex rollout parser checks passed.');

const assert = require('assert');
const {
  finalizeActiveToolCalls,
  normalizeElapsedDuration,
  formatElapsedDuration,
  createGenerationPoller,
} = require('../public/chat-stream-state');

assert.strictEqual(normalizeElapsedDuration(-1), null);
assert.strictEqual(normalizeElapsedDuration(null), null);
assert.strictEqual(normalizeElapsedDuration(''), null);
assert.strictEqual(normalizeElapsedDuration('1234.9'), 1234);
assert.strictEqual(formatElapsedDuration(0), '00:00:00');
assert.strictEqual(formatElapsedDuration(3723000), '01:02:03');
assert.strictEqual(formatElapsedDuration(90061000), '25:01:01');

let scheduledRefresh = null;
let scheduledInterval = null;
const clearedTimers = [];
let scheduleCount = 0;
let refreshCount = 0;
const poller = createGenerationPoller(() => { refreshCount += 1; }, 2000, {
  setInterval(refresh, intervalMs) {
    scheduleCount += 1;
    scheduledRefresh = refresh;
    scheduledInterval = intervalMs;
    return 'git-status-timer';
  },
  clearInterval(timerId) {
    clearedTimers.push(timerId);
  },
});

assert.strictEqual(poller.isRunning(), false);
poller.start();
poller.start();
assert.strictEqual(scheduleCount, 1);
assert.strictEqual(typeof scheduledRefresh, 'function');
assert.strictEqual(scheduledInterval, 2000);
assert.strictEqual(poller.isRunning(), true);
scheduledRefresh();
assert.strictEqual(refreshCount, 1);
poller.stop();
poller.stop();
assert.deepStrictEqual(clearedTimers, ['git-status-timer']);
assert.strictEqual(poller.isRunning(), false);

const { createAgentRuntime } = require('../lib/agent-runtime');

const pendingResult = { output: 'command completed' };
const toolCalls = new Map([
  ['pending-tool', { name: 'Bash', result: pendingResult, done: false }],
  ['completed-tool', { name: 'Read', result: 'file content', done: true }],
]);
const updates = [];

const finalizedCount = finalizeActiveToolCalls(toolCalls, (id, result) => {
  updates.push({ id, result });
});

assert.strictEqual(finalizedCount, 1);
assert.strictEqual(toolCalls.get('pending-tool').done, true);
assert.strictEqual(toolCalls.get('pending-tool').result, pendingResult);
assert.deepStrictEqual(updates, [{ id: 'pending-tool', result: pendingResult }]);

const sentMessages = [];
const runtime = createAgentRuntime({
  processEnv: {},
  MODEL_MAP: {},
  loadModelConfig() { return {}; },
  wsSend(_ws, message) { sentMessages.push(message); },
  truncateObj(value) { return value; },
  sanitizeToolInput(_name, value) { return value; },
  loadSession() { return null; },
  saveSession() {},
  setRuntimeSessionId() {},
  getRuntimeSessionId() { return ''; },
  getGitWorkingTreeStats() { return new Map(); },
});
const runtimeEntry = {
  agent: 'codex',
  ws: {},
  cwd: '',
  fullText: '',
  toolCalls: [],
  assistantSteps: [],
};

runtime.processCodexEvent(runtimeEntry, {
  type: 'item.started',
  item: {
    id: 'file-change-1',
    type: 'file_change',
    status: 'in_progress',
    changes: [{ path: '__missing_runtime_test__.txt', kind: 'update' }],
  },
}, 'session-1');
runtime.processCodexEvent(runtimeEntry, {
  type: 'item.completed',
  item: { id: 'message-1', type: 'agent_message', text: '任务完成' },
}, 'session-1');

assert.strictEqual(runtimeEntry.toolCalls[0].done, true);
assert.deepStrictEqual(sentMessages.map((message) => message.type), ['tool_start', 'tool_end', 'text_delta']);
assert.strictEqual(sentMessages[1].toolUseId, 'file-change-1');

runtime.processCodexEvent(runtimeEntry, {
  type: 'item.started',
  item: {
    id: 'command-1',
    type: 'command_execution',
    command: 'echo done',
    status: 'in_progress',
  },
}, 'session-1');
runtime.processCodexEvent(runtimeEntry, { type: 'turn.completed', usage: null }, 'session-1');

assert.strictEqual(runtimeEntry.toolCalls[1].done, true);
assert.strictEqual(sentMessages.at(-1).type, 'tool_end');
assert.strictEqual(sentMessages.at(-1).toolUseId, 'command-1');

console.log('chat stream state tests passed');

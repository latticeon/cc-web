(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CcChatStreamState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function finalizeActiveToolCalls(activeToolCalls, updateToolCall) {
    let finalizedCount = 0;
    activeToolCalls.forEach((tool, toolUseId) => {
      if (tool.done) return;
      tool.done = true;
      updateToolCall(toolUseId, tool.result);
      finalizedCount += 1;
    });
    return finalizedCount;
  }

  return { finalizeActiveToolCalls };
});

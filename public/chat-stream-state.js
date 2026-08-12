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

  function normalizeElapsedDuration(value) {
    if (value === null || value === undefined || value === '') return null;
    const duration = Number(value);
    return Number.isFinite(duration) && duration >= 0 ? Math.floor(duration) : null;
  }

  function formatElapsedDuration(value) {
    const duration = normalizeElapsedDuration(value) || 0;
    const totalSeconds = Math.floor(duration / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
  }

  function createGenerationPoller(refresh, intervalMs, clock = {}) {
    const schedule = clock.setInterval || setInterval;
    const cancel = clock.clearInterval || clearInterval;
    let timerId = null;

    return {
      start() {
        if (timerId !== null) return;
        timerId = schedule(refresh, intervalMs);
      },
      stop() {
        if (timerId === null) return;
        cancel(timerId);
        timerId = null;
      },
      isRunning() {
        return timerId !== null;
      },
    };
  }

  function calculateScrollIndicator(scrollTop, scrollHeight, clientHeight, trackHeight, minThumbHeight = 24) {
    const maxScrollTop = scrollHeight - clientHeight;
    if (maxScrollTop <= 1 || trackHeight <= 0) return null;
    const thumbHeight = Math.min(trackHeight, Math.max(minThumbHeight, trackHeight * clientHeight / scrollHeight));
    const clampedScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
    const thumbTop = (clampedScrollTop / maxScrollTop) * (trackHeight - thumbHeight);
    return { thumbHeight, thumbTop };
  }

  function getNextDisplayLimit(currentLimit, totalCount, increment = 10) {
    const current = Math.max(0, Number(currentLimit) || 0);
    const total = Math.max(0, Number(totalCount) || 0);
    const step = Math.max(1, Number(increment) || 10);
    return Math.min(total, current + step);
  }

  return {
    finalizeActiveToolCalls,
    normalizeElapsedDuration,
    formatElapsedDuration,
    createGenerationPoller,
    calculateScrollIndicator,
    getNextDisplayLimit,
  };
});

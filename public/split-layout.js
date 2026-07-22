(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CcSplitLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const DEFAULT_LIMITS = {
    sidebar: { min: 220, max: 480, initial: 280 },
    right: { min: 280, max: 720, initial: 320 },
    chatMin: 360,
    handleWidth: 7,
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeWidth(value, limits) {
    if (value === null || value === undefined || value === '') return limits.initial;
    const parsed = Number(value);
    return clamp(Number.isFinite(parsed) ? parsed : limits.initial, limits.min, limits.max);
  }

  function fitColumnWidths(options) {
    const limits = options.limits || DEFAULT_LIMITS;
    let sidebarWidth = normalizeWidth(options.sidebarWidth, limits.sidebar);
    let rightWidth = normalizeWidth(options.rightWidth, limits.right);
    const rightOpen = !!options.rightOpen;
    const handleCount = rightOpen ? 2 : 1;
    const available = Number(options.containerWidth) - limits.chatMin - (limits.handleWidth * handleCount);

    if (Number.isFinite(available) && available > 0) {
      let overflow = sidebarWidth + (rightOpen ? rightWidth : 0) - available;
      if (rightOpen && overflow > 0) {
        const rightReduction = Math.min(overflow, rightWidth - limits.right.min);
        rightWidth -= rightReduction;
        overflow -= rightReduction;
      }
      if (overflow > 0) {
        sidebarWidth -= Math.min(overflow, sidebarWidth - limits.sidebar.min);
      }
    }

    return { sidebarWidth, rightWidth };
  }

  function createSplitLayout(options) {
    const {
      app,
      sidebarResizer,
      rightResizer,
      storage = root.localStorage,
      desktopQuery = root.matchMedia('(min-width: 769px)'),
    } = options;
    const limits = options.limits || DEFAULT_LIMITS;
    const storageKeys = {
      sidebar: 'cc-web-sidebar-width',
      right: 'cc-web-git-panel-width',
    };
    const preferred = {
      sidebar: normalizeWidth(readStoredWidth(storage, storageKeys.sidebar), limits.sidebar),
      right: normalizeWidth(readStoredWidth(storage, storageKeys.right), limits.right),
    };
    let rightOpen = false;
    let drag = null;

    function applyLayout() {
      const fitted = fitColumnWidths({
        containerWidth: app.clientWidth,
        sidebarWidth: preferred.sidebar,
        rightWidth: preferred.right,
        rightOpen,
        limits,
      });
      app.style.setProperty('--sidebar-width', `${fitted.sidebarWidth}px`);
      app.style.setProperty('--git-panel-width', `${fitted.rightWidth}px`);
      sidebarResizer.setAttribute('aria-valuenow', String(Math.round(fitted.sidebarWidth)));
      rightResizer.setAttribute('aria-valuenow', String(Math.round(fitted.rightWidth)));
      return fitted;
    }

    function saveWidth(side) {
      try {
        storage.setItem(storageKeys[side], String(Math.round(preferred[side])));
      } catch {}
    }

    function updatePreferredWidth(side, width) {
      const columnLimits = limits[side];
      preferred[side] = clamp(width, columnLimits.min, columnLimits.max);
      applyLayout();
    }

    function beginResize(side, event) {
      if (!desktopQuery.matches || (event.button !== undefined && event.button !== 0)) return;
      const fitted = applyLayout();
      drag = { side, startX: event.clientX, startWidth: fitted[`${side}Width`] };
      document.body.classList.add('column-resizing');
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }

    function moveResize(event) {
      if (!drag) return;
      const delta = event.clientX - drag.startX;
      const nextWidth = drag.side === 'sidebar'
        ? drag.startWidth + delta
        : drag.startWidth - delta;
      updatePreferredWidth(drag.side, nextWidth);
      event.preventDefault();
    }

    function endResize() {
      if (!drag) return;
      saveWidth(drag.side);
      drag = null;
      document.body.classList.remove('column-resizing');
    }

    function handleKeyResize(side, event) {
      if (!desktopQuery.matches || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const delta = side === 'sidebar' ? direction * 16 : direction * -16;
      const fitted = applyLayout();
      updatePreferredWidth(side, fitted[`${side}Width`] + delta);
      saveWidth(side);
      event.preventDefault();
    }

    function resetWidth(side) {
      preferred[side] = limits[side].initial;
      applyLayout();
      saveWidth(side);
    }

    sidebarResizer.addEventListener('pointerdown', (event) => beginResize('sidebar', event));
    rightResizer.addEventListener('pointerdown', (event) => beginResize('right', event));
    sidebarResizer.addEventListener('keydown', (event) => handleKeyResize('sidebar', event));
    rightResizer.addEventListener('keydown', (event) => handleKeyResize('right', event));
    sidebarResizer.addEventListener('dblclick', () => resetWidth('sidebar'));
    rightResizer.addEventListener('dblclick', () => resetWidth('right'));
    document.addEventListener('pointermove', moveResize);
    document.addEventListener('pointerup', endResize);
    document.addEventListener('pointercancel', endResize);

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(applyLayout).observe(app);
    } else {
      root.addEventListener('resize', applyLayout);
    }

    applyLayout();
    return {
      refresh: applyLayout,
      setRightPanelOpen(open) {
        rightOpen = !!open;
        rightResizer.hidden = !rightOpen;
        applyLayout();
      },
    };
  }

  function readStoredWidth(storage, key) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  return { DEFAULT_LIMITS, fitColumnWidths, createSplitLayout };
});

const assert = require('assert');
const { createSplitLayout, fitColumnWidths } = require('../public/split-layout');

assert.deepStrictEqual(
  fitColumnWidths({ containerWidth: 1440, sidebarWidth: null, rightWidth: null, rightOpen: true }),
  { sidebarWidth: 280, rightWidth: 320 },
);

assert.deepStrictEqual(
  fitColumnWidths({ containerWidth: 1440, sidebarWidth: 300, rightWidth: 500, rightOpen: true }),
  { sidebarWidth: 300, rightWidth: 500 },
);

assert.deepStrictEqual(
  fitColumnWidths({ containerWidth: 1000, sidebarWidth: 300, rightWidth: 500, rightOpen: true }),
  { sidebarWidth: 300, rightWidth: 326 },
);

assert.deepStrictEqual(
  fitColumnWidths({ containerWidth: 900, sidebarWidth: 300, rightWidth: 500, rightOpen: true }),
  { sidebarWidth: 246, rightWidth: 280 },
);

assert.deepStrictEqual(
  fitColumnWidths({ containerWidth: 700, sidebarWidth: 400, rightWidth: 500, rightOpen: false }),
  { sidebarWidth: 333, rightWidth: 500 },
);

function createEventTarget(extra = {}) {
  return {
    addEventListener() {},
    setAttribute() {},
    ...extra,
  };
}

const originalDocument = global.document;
const originalResizeObserver = global.ResizeObserver;
const storedValues = new Map();
const desktopQuery = { matches: true };
global.document = {
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
};
global.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback(); }
};

try {
  const app = createEventTarget({
    clientWidth: 1200,
    style: { setProperty() {} },
  });
  const layout = createSplitLayout({
    app,
    sidebarResizer: createEventTarget(),
    rightResizer: createEventTarget({ hidden: true }),
    storage: {
      getItem(key) { return storedValues.has(key) ? storedValues.get(key) : null; },
      setItem(key, value) { storedValues.set(key, value); },
    },
    desktopQuery,
  });
  assert.strictEqual(typeof layout.setRightPanelOpen, 'function');
  assert.strictEqual(layout.getRememberedRightPanelOpen(), true);
  layout.rememberRightPanelOpen(false);
  assert.strictEqual(layout.getRememberedRightPanelOpen(), false);
  desktopQuery.matches = false;
  layout.rememberRightPanelOpen(true);
  assert.strictEqual(layout.getRememberedRightPanelOpen(), false);
  assert.strictEqual(storedValues.get('cc-web-git-panel-open'), '0');
  desktopQuery.matches = true;
  layout.setRightPanelOpen(true);
} finally {
  global.document = originalDocument;
  global.ResizeObserver = originalResizeObserver;
}

console.log('split layout tests passed');

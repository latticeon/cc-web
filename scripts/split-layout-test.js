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
    storage: { getItem() { return null; }, setItem() {} },
    desktopQuery: { matches: true },
  });
  assert.strictEqual(typeof layout.setRightPanelOpen, 'function');
  layout.setRightPanelOpen(true);
} finally {
  global.document = originalDocument;
  global.ResizeObserver = originalResizeObserver;
}

console.log('split layout tests passed');

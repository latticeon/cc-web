const assert = require('assert');
const { countLineChanges } = require('../lib/line-change-stats');

assert.deepStrictEqual(
  countLineChanges('alpha\nbeta\ngamma\n', 'alpha\nchanged\ngamma\nextra\n'),
  { additions: 2, deletions: 1 },
);
assert.deepStrictEqual(
  countLineChanges('', 'first\nsecond\n'),
  { additions: 2, deletions: 0 },
);
assert.deepStrictEqual(
  countLineChanges('first\nsecond\n', ''),
  { additions: 0, deletions: 2 },
);

console.log('Line change stats checks passed.');

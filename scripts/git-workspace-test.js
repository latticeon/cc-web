const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readGitFileDiff, readGitHistory } = require('../lib/git-workspace');
const { parseUnifiedDiff } = require('../public/git-workspace-view');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-web-git-workspace-'));

function git(args) {
  const result = spawnSync('git', args, {
    cwd: tempRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.strictEqual(result.status, 0, String(result.stderr || result.stdout || '').trim());
}

try {
  git(['init']);
  git(['config', 'user.name', 'CC Web Test']);
  git(['config', 'user.email', 'test@example.com']);

  const baseLines = Array.from({ length: 20 }, (_item, index) => `line ${index + 1}`);
  fs.writeFileSync(path.join(tempRoot, 'diff.txt'), `${baseLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'deleted.txt'), 'delete me\n', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'history.txt'), '0\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', '初始提交']);

  for (let index = 1; index <= 4; index += 1) {
    fs.appendFileSync(path.join(tempRoot, 'history.txt'), `${index}\n`, 'utf8');
    git(['add', 'history.txt']);
    git(['commit', '-m', `历史提交 ${index}`]);
  }

  const firstPage = readGitHistory(tempRoot, { offset: 0, limit: 2 });
  const secondPage = readGitHistory(tempRoot, { offset: firstPage.nextOffset, limit: 2 });
  const thirdPage = readGitHistory(tempRoot, { offset: secondPage.nextOffset, limit: 2 });
  assert.strictEqual(firstPage.available, true);
  assert.strictEqual(firstPage.commits.length, 2);
  assert.strictEqual(firstPage.hasMore, true);
  assert.strictEqual(secondPage.commits.length, 2);
  assert.strictEqual(secondPage.hasMore, true);
  assert.strictEqual(thirdPage.commits.length, 1);
  assert.strictEqual(thirdPage.hasMore, false);
  const hashes = [...firstPage.commits, ...secondPage.commits, ...thirdPage.commits].map((commit) => commit.hash);
  assert.strictEqual(new Set(hashes).size, 5);

  const changedLines = baseLines.slice();
  changedLines.splice(9, 2, 'line 10 changed', 'line 10 added');
  fs.writeFileSync(path.join(tempRoot, 'diff.txt'), `${changedLines.join('\n')}\n`, 'utf8');
  const modifiedDiff = readGitFileDiff(tempRoot, { path: 'diff.txt', status: 'modified', contextLines: 3 });
  assert.strictEqual(modifiedDiff.available, true);
  assert(modifiedDiff.diff.includes('-line 10'));
  assert(modifiedDiff.diff.includes('-line 11'));
  assert(modifiedDiff.diff.includes('+line 10 changed'));
  assert(modifiedDiff.diff.includes('+line 10 added'));
  assert(!modifiedDiff.diff.includes(' line 1\n'));
  assert(!modifiedDiff.diff.includes(' line 20\n'));
  const renderedLines = parseUnifiedDiff(modifiedDiff.diff);
  const deletedLine = renderedLines.find((line) => line.kind === 'deletion' && line.code === 'line 10');
  const addedLine = renderedLines.find((line) => line.kind === 'addition' && line.code === 'line 10 changed');
  assert.strictEqual(deletedLine.oldLabel, '10');
  assert.strictEqual(deletedLine.newLabel, '');
  assert.strictEqual(addedLine.oldLabel, '');
  assert.strictEqual(addedLine.newLabel, '10');

  fs.unlinkSync(path.join(tempRoot, 'deleted.txt'));
  const deletedDiff = readGitFileDiff(tempRoot, { path: 'deleted.txt', status: 'deleted', contextLines: 3 });
  assert.strictEqual(deletedDiff.available, true);
  assert(deletedDiff.diff.includes('-delete me'));

  fs.writeFileSync(path.join(tempRoot, 'untracked.txt'), 'first\nsecond\n', 'utf8');
  const untrackedDiff = readGitFileDiff(tempRoot, { path: 'untracked.txt', status: 'untracked', contextLines: 3 });
  assert.strictEqual(untrackedDiff.available, true);
  assert(untrackedDiff.diff.includes('@@ -0,0 +1,2 @@'));
  assert(untrackedDiff.diff.includes('+first'));
  assert(untrackedDiff.diff.includes('+second'));

  const escaped = readGitFileDiff(tempRoot, { path: '../outside.txt', status: 'modified' });
  assert.strictEqual(escaped.available, false);
  console.log('git workspace regression test passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

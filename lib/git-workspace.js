const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 50;
const MAX_DIFF_BUFFER = 4 * 1024 * 1024;
const MAX_UNTRACKED_FILE_SIZE = 1024 * 1024;

function runGit(cwd, args, options = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout || 5000,
    windowsHide: true,
    maxBuffer: options.maxBuffer || MAX_DIFF_BUFFER,
  });
}

function isGitRepository(cwd) {
  const result = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0 && String(result.stdout || '').trim() === 'true';
}

function normalizePageNumber(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function parseGitLogOutput(output) {
  return String(output || '')
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', author = '', authoredAt = '', ...subjectParts] = record.split('\x1f');
      return {
        hash,
        shortHash,
        author,
        authoredAt,
        subject: subjectParts.join('\x1f'),
      };
    })
    .filter((commit) => commit.hash);
}

function readGitHistory(cwd, options = {}) {
  if (!isGitRepository(cwd)) {
    return { available: false, commits: [], offset: 0, nextOffset: 0, hasMore: false };
  }

  const offset = normalizePageNumber(options.offset, 0);
  const limit = Math.max(1, normalizePageNumber(options.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT));
  const branchResult = runGit(cwd, ['branch', '--show-current']);
  let branch = String(branchResult.stdout || '').trim();
  if (!branch) {
    const headResult = runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    const detachedHead = String(headResult.stdout || '').trim();
    if (detachedHead) branch = `detached@${detachedHead}`;
  }

  const format = '%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e';
  const logResult = runGit(cwd, [
    'log',
    `--skip=${offset}`,
    '-n',
    String(limit + 1),
    `--pretty=format:${format}`,
  ]);
  if (logResult.status !== 0) {
    const hasHead = runGit(cwd, ['rev-parse', '--verify', 'HEAD']).status === 0;
    if (!hasHead) {
      return { available: true, branch, commits: [], offset, nextOffset: offset, hasMore: false };
    }
    return {
      available: false,
      branch,
      commits: [],
      offset,
      nextOffset: offset,
      hasMore: false,
      error: String(logResult.stderr || '').trim() || '无法读取 Git 提交记录',
    };
  }

  const parsed = parseGitLogOutput(logResult.stdout);
  const hasMore = parsed.length > limit;
  const commits = parsed.slice(0, limit);
  return {
    available: true,
    branch,
    commits,
    offset,
    nextOffset: offset + commits.length,
    hasMore,
  };
}

function resolveWorkspacePath(cwd, relativePath) {
  const root = path.resolve(cwd);
  const target = path.resolve(root, String(relativePath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('文件路径无效或超出工作目录');
  }
  return {
    target,
    relativePath: relative.replace(/\\/g, '/'),
  };
}

function diffPathLabel(prefix, relativePath) {
  const label = `${prefix}/${relativePath}`;
  return /[\s"\\]/.test(label) ? JSON.stringify(label) : label;
}

function buildUntrackedFileDiff(cwd, relativePath) {
  const { target, relativePath: normalizedPath } = resolveWorkspacePath(cwd, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size > MAX_UNTRACKED_FILE_SIZE) throw new Error('文件超过 1MB，无法生成差异预览');
  const buffer = fs.readFileSync(target);
  const oldLabel = '/dev/null';
  const newLabel = diffPathLabel('b', normalizedPath);
  const header = [
    `diff --git ${diffPathLabel('a', normalizedPath)} ${newLabel}`,
    'new file mode 100644',
    `--- ${oldLabel}`,
    `+++ ${newLabel}`,
  ];
  if (buffer.includes(0)) return `${header.join('\n')}\nBinary files ${oldLabel} and ${newLabel} differ`;

  const text = buffer.toString('utf8').replace(/\r\n/g, '\n');
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTrailingNewline) lines.pop();
  if (lines.length === 0) return header.join('\n');
  const body = lines.map((line) => `+${line}`);
  if (!hasTrailingNewline) body.push('\\ No newline at end of file');
  return `${header.join('\n')}\n@@ -0,0 +1,${lines.length} @@\n${body.join('\n')}`;
}

function readGitFileDiff(cwd, options = {}) {
  if (!isGitRepository(cwd)) return { available: false, diff: '', error: '当前目录不是 Git 仓库' };

  let current;
  let original = null;
  try {
    current = resolveWorkspacePath(cwd, options.path);
    if (options.originalPath) original = resolveWorkspacePath(cwd, options.originalPath);
  } catch (error) {
    return { available: false, diff: '', error: error.message };
  }

  try {
    if (options.status === 'untracked') {
      return { available: true, path: current.relativePath, diff: buildUntrackedFileDiff(cwd, current.relativePath) };
    }

    const contextLines = Math.max(0, Math.min(normalizePageNumber(options.contextLines, 3, 10), 10));
    const paths = Array.from(new Set([original?.relativePath, current.relativePath].filter(Boolean)));
    const diffResult = runGit(cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      `--unified=${contextLines}`,
      'HEAD',
      '--',
      ...paths,
    ]);
    if (diffResult.status === 0) {
      return { available: true, path: current.relativePath, diff: String(diffResult.stdout || '') };
    }

    if (options.status === 'added' && fs.existsSync(current.target)) {
      return { available: true, path: current.relativePath, diff: buildUntrackedFileDiff(cwd, current.relativePath) };
    }
    return {
      available: false,
      path: current.relativePath,
      diff: '',
      error: String(diffResult.stderr || '').trim() || '无法读取文件差异',
    };
  } catch (error) {
    return { available: false, path: current.relativePath, diff: '', error: error.message };
  }
}

module.exports = {
  buildUntrackedFileDiff,
  parseGitLogOutput,
  readGitFileDiff,
  readGitHistory,
};

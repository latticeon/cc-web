(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CcGitWorkspaceView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function parseUnifiedDiff(diffText) {
    const lines = String(diffText || '').replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const rows = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    lines.forEach((rawLine) => {
      let kind = 'context';
      let oldLabel = '';
      let newLabel = '';
      let marker = '';
      let code = rawLine;
      const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      const isNoNewlineMarker = /^\\ No newline/.test(rawLine);

      if (rawLine.startsWith('diff --git ')) {
        kind = 'meta';
        inHunk = false;
      } else if (hunkMatch) {
        kind = 'hunk';
        inHunk = true;
        oldLine = Number(hunkMatch[1]);
        newLine = Number(hunkMatch[2]);
      } else if (!inHunk || isNoNewlineMarker) {
        kind = 'meta';
      } else if (rawLine.startsWith('+')) {
        kind = 'addition';
        newLabel = String(newLine++);
        marker = '+';
        code = rawLine.slice(1);
      } else if (rawLine.startsWith('-')) {
        kind = 'deletion';
        oldLabel = String(oldLine++);
        marker = '-';
        code = rawLine.slice(1);
      } else {
        oldLabel = String(oldLine++);
        newLabel = String(newLine++);
        marker = rawLine.startsWith(' ') ? ' ' : '';
        code = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      }

      rows.push({ kind, oldLabel, newLabel, marker, code });
    });
    return rows;
  }

  function createDiffContent(doc, diffText) {
    const content = doc.createElement('div');
    content.className = 'workspace-diff-content';
    parseUnifiedDiff(diffText).forEach((line) => {
      const row = doc.createElement('div');
      row.className = `workspace-diff-line ${line.kind}`;
      const oldNumber = doc.createElement('span');
      oldNumber.className = 'workspace-diff-old';
      oldNumber.textContent = line.oldLabel;
      const newNumber = doc.createElement('span');
      newNumber.className = 'workspace-diff-new';
      newNumber.textContent = line.newLabel;
      const marker = doc.createElement('span');
      marker.className = 'workspace-diff-marker';
      marker.textContent = line.marker;
      const code = doc.createElement('span');
      code.className = 'workspace-diff-code';
      code.textContent = line.code;
      row.append(oldNumber, newNumber, marker, code);
      content.appendChild(row);
    });
    return content;
  }

  function getWorkspaceRelativePath(filePath, workspaceRoot) {
    const normalizedPath = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const normalizedRoot = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedRoot) return normalizedPath;
    const caseInsensitive = /^[a-z]:\//i.test(normalizedRoot) || normalizedRoot.startsWith('//');
    const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
    return comparablePath.startsWith(`${comparableRoot}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath;
  }

  function splitFileDisplayPath(filePath) {
    const displayPath = String(filePath || '');
    const separatorIndex = Math.max(displayPath.lastIndexOf('/'), displayPath.lastIndexOf('\\'));
    if (separatorIndex < 0) return { directory: '', filename: displayPath };
    return {
      directory: displayPath.slice(0, separatorIndex + 1),
      filename: displayPath.slice(separatorIndex + 1),
    };
  }

  function collectAssistantFileChanges(steps, workspaceRoot = '') {
    const changesByPath = new Map();
    (Array.isArray(steps) ? steps : []).forEach((step) => {
      if (!step || step.type !== 'tool_call') return;
      const kind = step.kind || step.meta?.kind || '';
      if (kind !== 'file_change' || !Array.isArray(step.meta?.changes)) return;
      step.meta.changes.forEach((change) => {
        const filePath = String(change?.path || '').trim();
        if (!filePath) return;
        const displayPath = getWorkspaceRelativePath(filePath, workspaceRoot);
        const caseInsensitive = /^[a-z]:[\\/]/i.test(workspaceRoot) || String(workspaceRoot).startsWith('\\\\');
        const key = caseInsensitive ? displayPath.toLowerCase() : displayPath;
        changesByPath.set(key, { ...(changesByPath.get(key) || {}), ...change, path: displayPath });
      });
    });
    return Array.from(changesByPath.values());
  }

  function createHistoryList(doc, commits, formatRelativeTime) {
    const list = doc.createElement('div');
    list.className = 'git-history-list';
    (Array.isArray(commits) ? commits : []).forEach((commit) => {
      const item = doc.createElement('div');
      item.className = 'git-history-item';
      item.title = commit.hash || '';
      const summary = doc.createElement('div');
      summary.className = 'git-history-summary';
      summary.textContent = commit.subject || '(无提交说明)';
      const meta = doc.createElement('div');
      meta.className = 'git-history-meta';
      const hash = doc.createElement('span');
      hash.className = 'git-history-hash';
      hash.textContent = commit.shortHash || String(commit.hash || '').slice(0, 8);
      const author = doc.createElement('span');
      author.className = 'git-history-author';
      author.textContent = commit.author || '未知作者';
      const date = doc.createElement('span');
      date.className = 'git-history-date';
      date.textContent = commit.authoredAt ? formatRelativeTime(commit.authoredAt) : '';
      if (commit.authoredAt) date.title = new Date(commit.authoredAt).toLocaleString('zh-CN');
      meta.append(hash, author, date);
      item.append(summary, meta);
      list.appendChild(item);
    });
    return list;
  }

  return {
    collectAssistantFileChanges,
    createDiffContent,
    createHistoryList,
    parseUnifiedDiff,
    getWorkspaceRelativePath,
    splitFileDisplayPath,
  };
});

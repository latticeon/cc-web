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
    createDiffContent,
    createHistoryList,
    parseUnifiedDiff,
  };
});

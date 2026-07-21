function splitLines(text) {
  const value = String(text || '').replace(/\r\n/g, '\n');
  if (!value) return [];
  return value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
}

function countLineChanges(beforeText, afterText) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const beforeLength = before.length;
  const afterLength = after.length;
  const maxDistance = beforeLength + afterLength;
  const furthest = new Map([[1, 0]]);

  for (let distance = 0; distance <= maxDistance; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let beforeIndex;
      if (diagonal === -distance || (diagonal !== distance && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1))) {
        beforeIndex = furthest.get(diagonal + 1) ?? 0;
      } else {
        beforeIndex = (furthest.get(diagonal - 1) ?? 0) + 1;
      }
      let afterIndex = beforeIndex - diagonal;
      while (beforeIndex < beforeLength && afterIndex < afterLength && before[beforeIndex] === after[afterIndex]) {
        beforeIndex++;
        afterIndex++;
      }
      furthest.set(diagonal, beforeIndex);
      if (beforeIndex >= beforeLength && afterIndex >= afterLength) {
        return {
          additions: (distance + afterLength - beforeLength) / 2,
          deletions: (distance + beforeLength - afterLength) / 2,
        };
      }
    }
  }

  return { additions: afterLength, deletions: beforeLength };
}

module.exports = { countLineChanges };

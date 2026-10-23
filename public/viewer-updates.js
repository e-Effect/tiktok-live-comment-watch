export function createSnapshotGuard() {
  const versions = new Map();
  return {
    capture(id) { return versions.get(id) || 0; },
    changed(id) { versions.set(id, (versions.get(id) || 0) + 1); },
    isCurrent(id, version) { return (versions.get(id) || 0) === version; },
    remove(id) { versions.delete(id); }
  };
}

// Reuse unchanged rows without detaching them, preserving focus and selection.
export function patchCommentRows(list, comments, render, emptyText) {
  const existing = new Map([...list.children].filter(row => row._commentKey).map(row => [row._commentKey, row]));
  const wanted = new Set();
  comments.forEach((comment, index) => {
    const key = String(comment.id || `${comment.userId}:${comment.at}:${index}`);
    wanted.add(key);
    const html = render(comment);
    let row = existing.get(key);
    if (!row || row._commentHtml !== html) {
      const template = list.ownerDocument.createElement('template');
      template.innerHTML = html;
      const replacement = template.content.firstElementChild;
      replacement._commentKey = key;
      replacement._commentHtml = html;
      if (row) row.replaceWith(replacement);
      row = replacement;
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
  });
  for (const row of [...list.children]) if (!wanted.has(row._commentKey)) row.remove();
  if (!comments.length) {
    const empty = list.ownerDocument.createElement('p');
    empty.className = 'empty'; empty.textContent = emptyText; list.append(empty);
  }
}

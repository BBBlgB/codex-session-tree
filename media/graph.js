(function (root) {
  'use strict';
  function normalizedPath(value) { return String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); }
  function buildForest(nodes, filters = {}) {
    const items = new Map(nodes.map(node => [node.id, { ...node, children: [], contextOnly: false }]));
    const allowed = new Set();
    for (const item of items.values()) {
      if ((!filters.archived && item.archived) || (!filters.agents && item.isAgent) || item.missing) continue;
      if (filters.workspace && !(filters.workspacePaths || []).some(p => normalizedPath(p) === normalizedPath(item.cwd))) continue;
      allowed.add(item.id);
    }
    const visible = new Set(allowed);
    for (const id of allowed) {
      let current = items.get(id);
      const seen = new Set([id]);
      while (current?.parentId && items.has(current.parentId) && !seen.has(current.parentId)) {
        visible.add(current.parentId); seen.add(current.parentId); current = items.get(current.parentId);
      }
    }
    const roots = [];
    for (const item of items.values()) {
      if (!visible.has(item.id)) continue;
      item.contextOnly = !allowed.has(item.id);
      const parent = items.get(item.parentId);
      // Collector already removes cycles; also tolerate independently supplied snapshots.
      let current = parent, cycle = false;
      const seen = new Set([item.id]);
      while (current) {
        if (seen.has(current.id)) { cycle = true; break; }
        seen.add(current.id); current = items.get(current.parentId);
      }
      if (parent && visible.has(parent.id) && !cycle) parent.children.push(item);
      else roots.push(item);
    }
    const query = (filters.query || '').trim().toLowerCase();
    function finish(item) {
      item.children.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      item.size = 1; item.latest = item.updatedAt || 0;
      item.matches = !query || [item.title, item.model, item.effort, item.cwd, item.id].some(x => String(x || '').toLowerCase().includes(query));
      for (const child of item.children) {
        finish(child); item.size += child.size; item.latest = Math.max(item.latest, child.latest); item.matches ||= child.matches;
      }
    }
    roots.forEach(finish);
    return roots.filter(item => item.matches && (!filters.branches || item.size > 1))
      .sort((a, b) => b.latest - a.latest || a.id.localeCompare(b.id));
  }
  const api = { buildForest, normalizedPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionGraph = api;
})(typeof globalThis === 'undefined' ? this : globalThis);

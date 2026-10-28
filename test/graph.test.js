'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForest } = require('../media/graph');
const { sessionUri, openSession } = require('../src/navigation');
const id = '11111111-1111-4111-8111-111111111111';
const a = { id: 'A', title: 'parent', updatedAt: 1, createdAt: 1, cwd: 'D:\\研究' };
const b = { id: 'B', parentId: 'A', title: 'child', updatedAt: 3, createdAt: 2, model: 'gpt-example', cwd: 'D:\\研究' };

test('branch filter shows connected families and retains parents of search matches', () => {
  const roots = buildForest([a, b, { id: 'C', title: 'independent' }], { branches: true, query: 'gpt-example' });
  assert.equal(roots.length, 1); assert.equal(roots[0].id, 'A'); assert.equal(roots[0].size, 2);
});
test('hidden archived parent remains as context for a visible branch', () => {
  const roots = buildForest([{ ...a, archived: true }, b]);
  assert.equal(roots[0].contextOnly, true); assert.equal(roots[0].children[0].contextOnly, false);
});
test('agents are independent of user forks and hidden by default', () => {
  const nodes = [a, b, { id: 'C', parentId: 'B', isAgent: true }];
  assert.equal(buildForest(nodes)[0].size, 2); assert.equal(buildForest(nodes, { agents: true })[0].size, 3);
});
test('workspace matching handles Windows extended path prefixes', () => {
  assert.equal(buildForest([a, b], { workspace: true, workspacePaths: ['\\\\?\\d:\\研究'] })[0].size, 2);
});
test('cycles cannot hide nodes or cause unbounded traversal', () => {
  assert.equal(buildForest([{ ...a, parentId: 'B' }, b]).length, 2);
});
test('alias, tags, and multiline notes participate in search while retaining the original title', () => {
  const nodes = [a, { ...b, annotation: { alias: '别名方案', tags: ['待验证'], note: '笔记\n边界条件' } }];
  for (const query of ['别名方案', '待验证', '边界条件', 'child']) {
    const roots = buildForest(nodes, { branches: true, query });
    assert.equal(roots.length, 1); assert.equal(roots[0].children[0].id, 'B');
    assert.equal(roots[0].children[0].title, 'child');
  }
});

test('removing a parent never restores it as context or removes its surviving children', () => {
  const nodes = [{ ...a, removed: true, archived: true }, b];
  const roots = buildForest(nodes, { branches: true });
  assert.equal(roots.length, 1); assert.equal(roots[0].id, 'B');
  assert.equal(roots[0].removedParent, true); assert.equal(roots[0].size, 1);
  assert.equal(buildForest(nodes, { query: 'parent' }).length, 0);
  const shown = buildForest(nodes, { branches: true, showRemoved: true });
  assert.equal(shown[0].id, 'A'); assert.equal(shown[0].removed, true);
  assert.equal(shown[0].children[0].id, 'B');
});

test('removing an intermediate node does not invent a direct ancestor-to-child edge', () => {
  const nodes = [a, { ...b, removed: true }, { id: 'C', parentId: 'B', title: 'grandchild' }];
  const original = structuredClone(nodes);
  const roots = buildForest(nodes, { branches: true });
  assert.deepEqual(roots.map(node => node.id).sort(), ['A', 'C']);
  assert.ok(roots.every(node => node.children.length === 0));
  assert.equal(roots.find(node => node.id === 'C').parentId, 'B');
  assert.deepEqual(nodes, original);
});

test('removing a leaf keeps the parent visible in branch mode and restoring reconnects it', () => {
  const nodes = [a, { ...b, removed: true }];
  const roots = buildForest(nodes, { branches: true });
  assert.equal(roots.length, 1); assert.equal(roots[0].id, 'A'); assert.equal(roots[0].size, 1);
  assert.equal(buildForest(nodes, { branches: true, query: 'child' }).length, 0);
  assert.equal(buildForest(nodes.map(node => ({ ...node, removed: false })), { branches: true })[0].size, 2);
  assert.equal(buildForest(nodes.map(node => ({ ...node, removed: true }))).length, 0);
});
test('navigation resolves and preserves the target window before opening Codex', async () => {
  const calls = [];
  const resolved = { path: `/local/${id}`, query: 'windowId=target-window', toString: () => `vscode-insiders://openai.chatgpt/local/${id}?windowId=target-window` };
  const mock = { env: { uriScheme: 'vscode-insiders', asExternalUri: async uri => { calls.push(['resolve', uri]); return resolved; } }, Uri: { from: value => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }) },
    extensions: { getExtension: () => ({ activate: async () => calls.push('activate') }) },
    commands: { executeCommand: async (...args) => calls.push(args) } };
  const url = await openSession(mock, { id, available: true });
  assert.equal(url, resolved.toString());
  assert.equal(calls[0], 'activate'); assert.equal(calls[1][0], 'resolve');
  assert.equal(calls[2][0], 'vscode.open'); assert.equal(calls[2][1], resolved);
  assert.throws(() => sessionUri(mock, '../../settings'), /无效/);
  await assert.rejects(() => openSession(mock, { id, available: false }), /不可用/);
});

test('search marks exact hits, includes standalone matches, and respects archive filters', () => {
  const nodes = [{ ...a, archived: true, title: 'needle' }, b, { id: 'C', title: 'standalone', annotation: { conclusion: 'needle' } }];
  const roots = buildForest(nodes, { branches: true, query: 'needle' });
  assert.deepEqual(roots.map(n => n.id), ['C']);
  assert.equal(roots[0].selfMatch, true); assert.equal(roots[0].matchText, 'needle');
  const match = buildForest([a, b], { query: 'child' })[0];
  assert.equal(match.selfMatch, false); assert.equal(match.matches, true); assert.equal(match.children[0].selfMatch, true);
});

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

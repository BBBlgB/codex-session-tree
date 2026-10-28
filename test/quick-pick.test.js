'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickItems } = require('../src/quick-pick');
const { annotateSnapshot, writeFavorite, recordOpened, writeAnnotation } = require('../src/annotations');
const id = '11111111-1111-4111-8111-111111111111';
const environment = { dataHome: '/home/example/.codex', platform: 'linux' };
const vscode = { QuickPickItemKind: { Separator: -1 }, ThemeIcon: class { constructor(id) { this.id = id; } } };

test('quick switch prioritizes favorites and opened history, with searchable original titles and notes', () => {
  const nodes = [
    { id: 'a', title: 'A', available: true, updatedAt: 20 },
    { id: 'b', title: 'Original B', available: true, updatedAt: 1, lastOpened: 8, annotation: { alias: 'Alias B', note: 'research note' } },
    { id: 'c', title: 'C', available: true, favorite: true, updatedAt: 0 },
    { id: 'd', title: 'D', available: true, removed: true },
    { id: 'e', title: 'E', available: false }
  ];
  const items = quickItems(nodes, vscode).filter(item => item.id);
  assert.deepEqual(items.map(item => item.id), ['c', 'b', 'a']);
  assert.equal(items[1].label, 'Alias B');
  assert.ok(items[1].detail.includes('Original B')); assert.ok(items[1].detail.includes('research note'));
});

test('favorite, recency and research notes persist separately and remain scoped to the data home', async () => {
  const values = new Map(); const storage = { get: key => values.get(key), update: async (key, value) => values.set(key, value) };
  const snapshot = { environment, nodes: [{ id, title: 'original', available: true }] };
  await writeFavorite(storage, environment, id, true); await recordOpened(storage, environment, id);
  await writeAnnotation(storage, environment, id, { alias: '', note: '', tags: [], objective: 'verify', conclusion: 'conditional', questions: 'bound?' });
  const node = annotateSnapshot(storage, snapshot).nodes[0];
  assert.equal(node.favorite, true); assert.ok(node.lastOpened > 0); assert.equal(node.annotation.questions, 'bound?');
  assert.equal(annotateSnapshot(storage, { ...snapshot, environment: { ...environment, dataHome: '/other' } }).nodes[0].favorite, false);
  await writeFavorite(storage, environment, id, false);
  assert.equal(annotateSnapshot(storage, snapshot).nodes[0].annotation.conclusion, 'conditional');
  await assert.rejects(() => writeFavorite(storage, environment, id, 'true'), /格式/);
});

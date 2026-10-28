'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { annotationKey, removalKey, writeNodeRemoved, normalizeAnnotation, readAnnotation, writeAnnotation, annotateSnapshot } = require('../src/annotations');
const id = '11111111-1111-4111-8111-111111111111';
const environment = { platform: 'win32', dataHome: 'D:\\Data\\.codex' };
function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { get: key => data.get(key), async update(key, value) { if (value === undefined) data.delete(key); else data.set(key, structuredClone(value)); }, data };
}

test('annotations survive storage reconstruction and do not replace Codex metadata', async () => {
  const storage = memory();
  const snapshot = { environment, nodes: [{ id, title: '原主题', model: 'example', relation: 'root' }] };
  const value = { alias: '  方案 B  ', tags: ['待验证', '进行中', '进行中'], note: '第一行\n第二行' };
  await writeAnnotation(storage, environment, id, value);
  const reloaded = memory(JSON.parse(JSON.stringify(Object.fromEntries(storage.data))));
  const annotated = annotateSnapshot(reloaded, snapshot);
  assert.deepEqual(annotated.nodes[0].annotation, { alias: '方案 B', tags: ['进行中', '待验证'], note: '第一行\n第二行' });
  assert.equal(annotated.nodes[0].title, '原主题'); assert.equal(snapshot.nodes[0].annotation, undefined);
});
test('annotations are shared across workspaces for the same home, and isolated by data home', async () => {
  const storage = memory();
  await writeAnnotation(storage, environment, id, { alias: '别名', tags: [], note: '' });
  assert.equal(readAnnotation(storage, { ...environment, workspace: 'another', dataHome: 'd:/data/.codex/' }, id).alias, '别名');
  assert.equal(readAnnotation(storage, { ...environment, dataHome: 'D:\\Other\\.codex' }, id).alias, '');
  assert.notEqual(annotationKey({ platform: 'linux', dataHome: '/home/User/.codex' }, id), annotationKey({ platform: 'linux', dataHome: '/home/user/.codex' }, id));
});
test('clearing all fields removes the overlay and leaves other nodes intact', async () => {
  const storage = memory(); const other = '22222222-2222-4222-8222-222222222222';
  await writeAnnotation(storage, environment, id, { alias: 'A', tags: [], note: '' });
  await writeAnnotation(storage, environment, other, { alias: 'B', tags: [], note: '' });
  await writeAnnotation(storage, environment, id, { alias: ' ', tags: [], note: '\n' });
  assert.equal(storage.data.has(annotationKey(environment, id)), false);
  assert.equal(readAnnotation(storage, environment, other).alias, 'B');
});
test('invalid input and storage failures never produce successful saves', async () => {
  const empty = { alias: '', tags: [], note: '' };
  assert.throws(() => normalizeAnnotation({ ...empty, tags: ['其他'] }), /标签/);
  assert.throws(() => normalizeAnnotation({ ...empty, alias: 'x'.repeat(121) }), /120/);
  assert.throws(() => normalizeAnnotation({ ...empty, note: 'x'.repeat(6001) }), /6000/);
  assert.throws(() => normalizeAnnotation({ ...empty, note: {} }), /格式/);
  await assert.rejects(() => writeAnnotation(memory(), environment, '../../settings', empty), /无效/);
  await assert.rejects(() => writeAnnotation({ update: async () => { throw new Error('disk unavailable'); } }, environment, id, empty), /disk unavailable/);
});

test('node removal persists in plugin storage without changing sessions or annotations', async () => {
  const storage = memory();
  const snapshot = { environment, nodes: [{ id, title: '原主题', parentId: null, available: true }] };
  const original = structuredClone(snapshot);
  await writeAnnotation(storage, environment, id, { alias: '保留别名', tags: ['待验证'], note: '保留备注' });
  await writeNodeRemoved(storage, environment, id, true);
  const reloaded = memory(JSON.parse(JSON.stringify(Object.fromEntries(storage.data))));
  assert.equal(annotateSnapshot(reloaded, snapshot).nodes[0].removed, true);
  assert.equal(annotateSnapshot(reloaded, { ...snapshot, environment: { ...environment, dataHome: 'd:/data/.codex/' } }).nodes[0].removed, true);
  assert.equal(annotateSnapshot(reloaded, { ...snapshot, environment: { ...environment, dataHome: 'D:\\Other\\.codex' } }).nodes[0].removed, false);
  await writeNodeRemoved(reloaded, environment, id, false);
  assert.equal(reloaded.data.has(removalKey(environment, id)), false);
  assert.equal(annotateSnapshot(reloaded, snapshot).nodes[0].removed, false);
  assert.equal(readAnnotation(reloaded, environment, id).alias, '保留别名');
  assert.deepEqual(snapshot, original);
});

test('node removal rejects invalid messages and propagates storage failures', async () => {
  await assert.rejects(() => writeNodeRemoved(memory(), environment, id, 'true'), /格式/);
  await assert.rejects(() => writeNodeRemoved(memory(), environment, '../session', true), /无效/);
  await assert.rejects(() => writeNodeRemoved({ update: async () => { throw new Error('disk unavailable'); } }, environment, id, true), /disk unavailable/);
});

'use strict';

const { createHash } = require('node:crypto');
const { normalizedPath } = require('../media/graph');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TAGS = ['进行中', '已完成', '待验证'];

function nodeKey(environment, id, namespace) {
  if (!UUID.test(id)) throw new Error('无效的会话 ID');
  const home = normalizedPath(environment.dataHome, environment.platform);
  const scope = createHash('sha256').update(home).digest('hex');
  return `${namespace}.v1.${scope}.${id}`;
}

function annotationKey(environment, id) { return nodeKey(environment, id, 'nodeAnnotation'); }
function removalKey(environment, id) { return nodeKey(environment, id, 'nodeRemoved'); }
function favoriteKey(environment, id) { return nodeKey(environment, id, 'nodeFavorite'); }
async function writeFavorite(storage, environment, id, favorite) {
  if (typeof favorite !== 'boolean') throw new Error('收藏状态格式无效。');
  await storage.update(favoriteKey(environment, id), favorite ? true : undefined);
}
async function recordOpened(storage, environment, id) {
  await storage.update(nodeKey(environment, id, 'nodeOpened'), Date.now());
}

async function writeNodeRemoved(storage, environment, id, removed) {
  if (typeof removed !== 'boolean') throw new Error('节点移除状态格式无效。');
  await storage.update(removalKey(environment, id), removed ? true : undefined);
}

function normalizeAnnotation(value) {
  if (!value || typeof value.alias !== 'string' || typeof value.note !== 'string' || !Array.isArray(value.tags)) {
    throw new Error('别名、标签或备注格式无效。');
  }
  if (value.alias.length > 120) throw new Error('别名最多 120 个字符。');
  if (value.note.length > 6000) throw new Error('备注最多 6000 个字符。');
  if (value.tags.length > TAGS.length || value.tags.some(tag => !TAGS.includes(tag))) throw new Error('标签仅支持进行中、已完成、待验证。');
  const annotation = { alias: value.alias.trim(), tags: TAGS.filter(tag => value.tags.includes(tag)), note: value.note.trim() };
  for (const field of ['objective', 'conclusion', 'questions']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > 6000)) throw new Error('研究记录必须是最多 6000 个字符的文本。');
    if (value[field]?.trim()) annotation[field] = value[field].trim();
  }
  return annotation;
}

function readAnnotation(storage, environment, id) {
  return storage.get(annotationKey(environment, id)) || { alias: '', tags: [], note: '' };
}

async function writeAnnotation(storage, environment, id, value) {
  const key = annotationKey(environment, id);
  const annotation = normalizeAnnotation(value);
  await storage.update(key, annotation.alias || annotation.note || annotation.tags.length || annotation.objective || annotation.conclusion || annotation.questions ? annotation : undefined);
  return annotation;
}

function annotateSnapshot(storage, snapshot) {
  return { ...snapshot, nodes: snapshot.nodes.map(item => ({ ...item,
    annotation: readAnnotation(storage, snapshot.environment, item.id),
    removed: storage.get(removalKey(snapshot.environment, item.id)) === true,
    favorite: storage.get(favoriteKey(snapshot.environment, item.id)) === true,
    lastOpened: storage.get(nodeKey(snapshot.environment, item.id, 'nodeOpened')) || 0
  })) };
}

module.exports = { annotationKey, removalKey, favoriteKey, writeFavorite, recordOpened, writeNodeRemoved, normalizeAnnotation, readAnnotation, writeAnnotation, annotateSnapshot };

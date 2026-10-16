'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRuntime, describeEnvironment } = require('../src/runtime');
const { buildForest, normalizedPath } = require('../media/graph');

test('Windows uses its own home and Python launcher without shell quoting', () => {
  const runtime = resolveRuntime({ platform: 'win32', home: 'C:\\Users\\example', extensionPath: 'C:\\Program Files\\session-tree' });
  assert.equal(runtime.python, 'py');
  assert.equal(runtime.dataHome, 'C:\\Users\\example\\.codex');
  assert.deepEqual(runtime.args.slice(0, 4), ['-3', '-X', 'utf8', 'C:\\Program Files\\session-tree\\scripts\\index_sessions.py']);
});
test('Linux resolves home and Python on the extension host', () => {
  const runtime = resolveRuntime({ platform: 'linux', home: '/home/example', extensionPath: '/home/example/.vscode-server/extensions/session-tree', env: { CODEX_HOME: '/srv/codex data' } });
  assert.equal(runtime.python, 'python3');
  assert.equal(runtime.dataHome, '/srv/codex data');
  assert.equal(runtime.args[0], '-X');
  const custom = resolveRuntime({ platform: 'linux', home: '/home/example', extensionPath: '/extension', codexHome: '~/data', pythonPath: '~/venv/bin/python' });
  assert.equal(custom.dataHome, '/home/example/data');
  assert.equal(custom.python, '/home/example/venv/bin/python');
});
test('mismatched Windows and Linux settings fail before scanning', () => {
  const base = { platform: 'linux', home: '/home/example', extensionPath: '/extension' };
  assert.throws(() => resolveRuntime({ ...base, codexHome: 'C:\\Users\\example\\.codex' }), /绝对路径/);
  assert.throws(() => resolveRuntime({ ...base, pythonPath: 'C:\\Python\\python.exe' }), /Linux/);
  assert.throws(() => resolveRuntime({ ...base, codexHome: '../data' }), /绝对路径/);
  assert.throws(() => resolveRuntime({ platform: 'win32', home: 'C:\\Users\\example', extensionPath: 'C:\\extension', codexHome: '/home/example/.codex' }), /绝对路径/);
});
test('Linux project paths remain case-sensitive and preserve backslashes', () => {
  assert.notEqual(normalizedPath('/work/Project', 'linux'), normalizedPath('/work/project', 'linux'));
  assert.notEqual(normalizedPath('/work/a\\b', 'linux'), normalizedPath('/work/a/b', 'linux'));
  assert.equal(normalizedPath('/', 'linux'), '/');
  const nodes = [{ id: 'one', cwd: '/work/Project' }, { id: 'two', cwd: '/work/project' }];
  assert.deepEqual(buildForest(nodes, { workspace: true, platform: 'linux', workspacePaths: ['/work/Project'] }).map(n => n.id), ['one']);
});
test('Windows project paths normalize drive case and extended UNC paths', () => {
  assert.equal(normalizedPath('D:\\Work\\Project', 'win32'), normalizedPath('d:/work/project/', 'win32'));
  assert.equal(normalizedPath('\\\\?\\UNC\\server\\share\\Project', 'win32'), normalizedPath('\\\\server\\share\\project', 'win32'));
});
test('environment identifies the exact SSH workspace and data host', () => {
  const vscode = { env: { remoteName: 'ssh-remote' }, workspace: { name: 'project', workspaceFolders: [{ name: 'project', uri: { scheme: 'vscode-remote', authority: 'ssh-remote+example-host', fsPath: '/work/project' } }] } };
  const info = describeEnvironment(vscode, { platform: 'linux', dataHome: '/home/example/.codex' }, 'example-host');
  assert.equal(info.label, 'Linux · ssh-remote+example-host');
  assert.deepEqual(info.workspacePaths, ['/work/project']);
  assert.equal(info.dataHome, '/home/example/.codex');
});
